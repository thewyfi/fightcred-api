/**
 * FightCred — Automated Fight Result Poller
 *
 * Runs as a background job inside the Express server.
 * Every 10 minutes it checks for fights that are:
 *   1. In "live" status (predictions locked, fight started)
 *   2. Scheduled to have started (status=upcoming but past scheduledStartTime)
 *
 * It queries the ESPN MMA API for results and auto-resolves fights,
 * which triggers the credibility scoring pipeline.
 *
 * ESPN MMA API (public, no key required):
 *   https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard
 *   https://site.api.espn.com/apis/site/v2/sports/mma/ufc/summary?event={id}
 */

import axios from "axios";
import { getDb } from "./db";
import { events, fights } from "../drizzle/schema";
import { and, eq, lte, or } from "drizzle-orm";
import { calculateCredibility, getTierFromScore } from "../shared/types";
import * as db from "./db";
import { notifyOwner } from "./_core/notification";

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/mma/ufc";
const POLL_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

// ─── ESPN Types ───────────────────────────────────────────────────────────────

interface ESPNCompetitor {
  id: string;
  athlete: { displayName: string; shortName: string };
  winner?: boolean;
  score?: string;
}

interface ESPNStatus {
  type: { name: string; completed: boolean; description: string };
}

interface ESPNCompetition {
  id: string;
  status: ESPNStatus;
  competitors: ESPNCompetitor[];
  details?: Array<{ type: { text: string }; clock?: { displayValue: string }; period?: number }>;
}

interface ESPNEvent {
  id: string;
  name: string;
  date: string;
  competitions: ESPNCompetition[];
}

// ─── Normalize method from ESPN text ─────────────────────────────────────────

function normalizeMethod(text: string): "tko_ko" | "submission" | "decision" | "draw" | "nc" {
  const t = text.toLowerCase();
  if (t.includes("ko") || t.includes("tko") || t.includes("knockout")) return "tko_ko";
  if (t.includes("sub") || t.includes("choke") || t.includes("lock") || t.includes("triangle")) return "submission";
  if (t.includes("draw")) return "draw";
  if (t.includes("no contest") || t.includes("nc")) return "nc";
  return "decision";
}

function normalizeFinishType(method: "tko_ko" | "submission" | "decision" | "draw" | "nc"): "finish" | "decision" {
  return method === "tko_ko" || method === "submission" ? "finish" : "decision";
}

// ─── Fuzzy name match ─────────────────────────────────────────────────────────

function fuzzyMatch(a: string, b: string): boolean {
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return true;
  // Check if last name matches
  const lastA = na.split(" ").pop() ?? na;
  const lastB = nb.split(" ").pop() ?? nb;
  if (lastA.length > 3 && lastA === lastB) return true;
  // Check if one contains the other
  if (na.includes(nb) || nb.includes(na)) return true;
  return false;
}

// ─── Fetch ESPN scoreboard for UFC events ────────────────────────────────────

async function fetchESPNScoreboard(): Promise<ESPNEvent[]> {
  try {
    const res = await axios.get(`${ESPN_BASE}/scoreboard`, {
      params: { limit: 20 },
      timeout: 10000,
    });
    return (res.data?.events ?? []) as ESPNEvent[];
  } catch (e) {
    console.warn("[ResultPoller] ESPN scoreboard fetch failed:", e);
    return [];
  }
}

async function fetchESPNEventSummary(espnEventId: string): Promise<ESPNEvent | null> {
  try {
    const res = await axios.get(`${ESPN_BASE}/summary`, {
      params: { event: espnEventId },
      timeout: 10000,
    });
    return res.data as ESPNEvent;
  } catch (e) {
    console.warn(`[ResultPoller] ESPN summary fetch failed for event ${espnEventId}:`, e);
    return null;
  }
}

// ─── Core poll logic ──────────────────────────────────────────────────────────

export async function pollFightResults(): Promise<{ resolved: number; errors: string[] }> {
  const drizzleDb = await getDb();
  if (!drizzleDb) return { resolved: 0, errors: ["Database not available"] };

  const now = new Date();
  const errors: string[] = [];
  let resolved = 0;

  // Find fights that should have results: live OR upcoming but past start time
  const pendingFights = await drizzleDb
    .select({ fight: fights, event: events })
    .from(fights)
    .innerJoin(events, eq(fights.eventId, events.id))
    .where(
      and(
        or(
          eq(fights.status, "live"),
          and(
            eq(fights.status, "upcoming"),
            lte(fights.scheduledStartTime, now),
          ),
        ),
      ),
    );

  if (pendingFights.length === 0) {
    console.log("[ResultPoller] No pending fights to check.");
    return { resolved: 0, errors: [] };
  }

  console.log(`[ResultPoller] Checking ${pendingFights.length} pending fights...`);

  // Fetch ESPN scoreboard
  const espnEvents = await fetchESPNScoreboard();

  for (const { fight, event } of pendingFights) {
    try {
      // Find matching ESPN event by name similarity
      const matchingESPNEvent = espnEvents.find((e) =>
        fuzzyMatch(e.name, event.name) ||
        fuzzyMatch(e.name, event.shortName ?? "") ||
        // Also match by date proximity (within 2 days)
        Math.abs(new Date(e.date).getTime() - new Date(event.eventDate).getTime()) < 2 * 24 * 60 * 60 * 1000,
      );

      if (!matchingESPNEvent) continue;

      // Find matching competition (fight) within the event
      const matchingComp = matchingESPNEvent.competitions.find((comp) => {
        const names = comp.competitors.map((c) => c.athlete.displayName);
        return (
          names.some((n) => fuzzyMatch(n, fight.fighter1Name)) &&
          names.some((n) => fuzzyMatch(n, fight.fighter2Name))
        );
      });

      if (!matchingComp) continue;
      if (!matchingComp.status.type.completed) continue;

      // Find winner
      const winner = matchingComp.competitors.find((c) => c.winner);
      if (!winner) continue;

      const winnerName = winner.athlete.displayName;

      // Determine which DB fighter name matches
      const resolvedWinner = fuzzyMatch(winnerName, fight.fighter1Name)
        ? fight.fighter1Name
        : fuzzyMatch(winnerName, fight.fighter2Name)
          ? fight.fighter2Name
          : null;

      if (!resolvedWinner) continue;

      // Get method from details
      let methodText = matchingComp.status.type.description ?? "Decision";
      if (matchingComp.details && matchingComp.details.length > 0) {
        methodText = matchingComp.details[0].type?.text ?? methodText;
      }

      const method = normalizeMethod(methodText);
      const finishType = normalizeFinishType(method);

      // Resolve the fight in DB
      await db.resolveFight(fight.id, resolvedWinner, finishType, method);

      // Lock predictions
      await db.lockPredictionsForFight(fight.id);

      // Trigger credibility scoring for all predictions on this fight
      const allPredictions = await db.getPredictionsForFight(fight.id);

      for (const pred of allPredictions) {
        const pickedFighter1 = pred.pickedWinner === fight.fighter1Name;
        const pickedOdds = pickedFighter1 ? fight.odds1 : fight.odds2;

        const breakdown = calculateCredibility(
          { pickedWinner: pred.pickedWinner, pickedFinishType: pred.pickedFinishType, pickedMethod: pred.pickedMethod },
          { winner: resolvedWinner, finishType, method },
          pickedOdds ?? null,
        );

        const correctWinner = pred.pickedWinner === resolvedWinner;
        const correctFinish = pred.pickedFinishType === finishType;
        const correctMethod =
          finishType === "finish" &&
          pred.pickedFinishType === "finish" &&
          pred.pickedMethod != null &&
          ((method === "tko_ko" && pred.pickedMethod === "tko_ko") ||
            (method === "submission" && pred.pickedMethod === "submission"));

        let status: "correct" | "wrong" | "partial" = "wrong";
        if (correctWinner && correctFinish && (finishType === "decision" || correctMethod)) {
          status = "correct";
        } else if (correctWinner || correctFinish) {
          status = "partial";
        }

        // Update prediction
        await drizzleDb.update(
          (await import("../drizzle/schema")).predictions,
        ).set({
          status,
          winnerPoints: breakdown.winnerPoints,
          finishTypePoints: breakdown.finishTypePoints,
          methodPoints: breakdown.methodPoints,
          bonusPoints: breakdown.underdogBonus + breakdown.perfectPickBonus,
          totalPoints: breakdown.totalPoints,
        }).where((await import("drizzle-orm")).eq((await import("../drizzle/schema")).predictions.id, pred.id));

        // Insert credibility log
        await db.insertCredibilityLog({
          userId: pred.userId,
          fightId: fight.id,
          predictionId: pred.id,
          winnerPoints: breakdown.winnerPoints,
          finishTypePoints: breakdown.finishTypePoints,
          methodPoints: breakdown.methodPoints,
          bonusPoints: breakdown.underdogBonus + breakdown.perfectPickBonus,
          totalPoints: breakdown.totalPoints,
          breakdown: JSON.stringify(breakdown),
        });

        // Update user profile stats
        const profile = await db.getUserProfile(pred.userId);
        if (profile) {
          const isUnderdog = pickedOdds != null && pickedOdds >= 150;
          const newScore = profile.credibilityScore + breakdown.totalPoints;
          const newTier = getTierFromScore(newScore);
          const newStreak = correctWinner ? profile.currentStreak + 1 : 0;

          await db.updateUserProfile(pred.userId, {
            credibilityScore: newScore,
            tier: newTier,
            totalPicks: profile.totalPicks + 1,
            correctPicks: profile.correctPicks + (correctWinner ? 1 : 0),
            correctFinishPicks: profile.correctFinishPicks + (correctFinish ? 1 : 0),
            totalFinishPicks: profile.totalFinishPicks + (pred.pickedFinishType != null ? 1 : 0),
            correctMethodPicks: profile.correctMethodPicks + (correctMethod ? 1 : 0),
            totalMethodPicks: profile.totalMethodPicks + (pred.pickedMethod != null ? 1 : 0),
            correctUnderdogPicks: profile.correctUnderdogPicks + (isUnderdog && correctWinner ? 1 : 0),
            totalUnderdogPicks: profile.totalUnderdogPicks + (isUnderdog ? 1 : 0),
            currentStreak: newStreak,
            bestStreak: Math.max(profile.bestStreak, newStreak),
          });

          await db.upsertFighterStat(pred.userId, pred.pickedWinner, correctWinner);
        }
      }

      resolved++;
      console.log(`[ResultPoller] ✅ Resolved: ${fight.fighter1Name} vs ${fight.fighter2Name} → ${resolvedWinner} by ${method}`);

      // Notify owner of auto-resolved fight
      await notifyOwner({
        title: `FightCred: Fight Auto-Resolved`,
        content: `${fight.fighter1Name} vs ${fight.fighter2Name} → Winner: ${resolvedWinner} by ${method.toUpperCase()}. ${allPredictions.length} predictions scored.`,
      }).catch(() => {});

    } catch (err) {
      const msg = `Error resolving ${fight.fighter1Name} vs ${fight.fighter2Name}: ${err}`;
      console.error(`[ResultPoller] ${msg}`);
      errors.push(msg);
    }
  }

  return { resolved, errors };
}

// ─── Start background polling ─────────────────────────────────────────────────

let pollerInterval: ReturnType<typeof setInterval> | null = null;

export function startResultPoller() {
  if (pollerInterval) return;

  console.log(`[ResultPoller] Starting — polling every ${POLL_INTERVAL_MS / 60000} minutes`);

  // Run immediately on start, then on interval
  pollFightResults().then(({ resolved, errors }) => {
    if (resolved > 0) console.log(`[ResultPoller] Initial poll: ${resolved} fights resolved`);
    if (errors.length > 0) console.warn(`[ResultPoller] Initial poll errors:`, errors);
  });

  pollerInterval = setInterval(async () => {
    const { resolved, errors } = await pollFightResults();
    if (resolved > 0) console.log(`[ResultPoller] Poll: ${resolved} fights resolved`);
    if (errors.length > 0) console.warn(`[ResultPoller] Poll errors:`, errors);
  }, POLL_INTERVAL_MS);
}

export function stopResultPoller() {
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
  }
}
