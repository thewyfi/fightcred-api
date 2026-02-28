import { z } from "zod";
import { COOKIE_NAME } from "../shared/const.js";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import * as db from "./db";
import { calculateCredibility, getTierFromScore } from "../shared/types";
import { pollFightResults } from "./result-poller";
import { ENV } from "./_core/env";
import axios from "axios";

// ─── Odds API Helper ──────────────────────────────────────────────────────────

const ODDS_API_KEY = process.env.ODDS_API_KEY ?? "";
const ODDS_API_BASE = "https://api.the-odds-api.com/v4";

async function fetchMMAOdds() {
  if (!ODDS_API_KEY) return [];
  try {
    const res = await axios.get(`${ODDS_API_BASE}/sports/mma_mixed_martial_arts/odds`, {
      params: {
        apiKey: ODDS_API_KEY,
        regions: "us",
        oddsFormat: "american",
        markets: "h2h",
      },
      timeout: 8000,
    });
    return res.data as Array<{
      id: string;
      commence_time: string;
      home_team: string;
      away_team: string;
      bookmakers: Array<{
        key: string;
        markets: Array<{
          key: string;
          outcomes: Array<{ name: string; price: number }>;
        }>;
      }>;
    }>;
  } catch (e) {
    console.warn("[OddsAPI] Failed to fetch:", e);
    return [];
  }
}

// ─── Router ───────────────────────────────────────────────────────────────────

export const appRouter = router({
  system: systemRouter,

  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),

  // ── Profile ──────────────────────────────────────────────────────────────
  profile: router({
    get: protectedProcedure.query(async ({ ctx }) => {
      return db.getUserProfile(ctx.user.id);
    }),

    getById: publicProcedure
      .input(z.object({ userId: z.number() }))
      .query(async ({ input }) => {
        return db.getUserProfile(input.userId);
      }),

    setup: protectedProcedure
      .input(z.object({
        username: z.string().min(3).max(32).regex(/^[a-zA-Z0-9_]+$/, "Only letters, numbers, underscores"),
        displayName: z.string().max(64).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const existing = await db.getUserProfile(ctx.user.id);
        if (existing) {
          await db.updateUserProfile(ctx.user.id, {
            username: input.username,
            displayName: input.displayName ?? input.username,
          });
          return existing.id;
        }
        return db.createUserProfile({
          userId: ctx.user.id,
          username: input.username,
          displayName: input.displayName ?? input.username,
        });
      }),

    update: protectedProcedure
      .input(z.object({ displayName: z.string().max(64).optional() }))
      .mutation(async ({ ctx, input }) => {
        await db.updateUserProfile(ctx.user.id, input);
      }),

    fighterStats: protectedProcedure.query(async ({ ctx }) => {
      return db.getUserFighterStats(ctx.user.id);
    }),

    fighterStatsById: publicProcedure
      .input(z.object({ userId: z.number() }))
      .query(async ({ input }) => {
        return db.getUserFighterStats(input.userId);
      }),

    credibilityLog: protectedProcedure.query(async ({ ctx }) => {
      return db.getCredibilityLog(ctx.user.id);
    }),

    credibilityLogById: publicProcedure
      .input(z.object({ userId: z.number() }))
      .query(async ({ input }) => {
        return db.getCredibilityLog(input.userId);
      }),

    getByUsername: publicProcedure
      .input(z.object({ username: z.string() }))
      .query(async ({ input }) => {
        return db.getProfileByUsername(input.username);
      }),
  }),

  // ── Events ────────────────────────────────────────────────────────────────
  events: router({
    list: publicProcedure.query(async () => {
      return db.getAllEvents();
    }),

    upcoming: publicProcedure.query(async () => {
      return db.getUpcomingEvents();
    }),

    getById: publicProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => {
        const event = await db.getEventById(input.id);
        if (!event) throw new Error("Event not found");
        return event;
      }),

    seed: protectedProcedure
      .input(z.object({
        name: z.string(),
        shortName: z.string().optional(),
        eventDate: z.string(),
        venue: z.string().optional(),
        location: z.string().optional(),
        imageUrl: z.string().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        if (ctx.user.role !== "admin") throw new Error("Admin only");
        return db.upsertEvent({
          name: input.name,
          shortName: input.shortName,
          eventDate: new Date(input.eventDate),
          venue: input.venue,
          location: input.location,
          imageUrl: input.imageUrl,
        });
      }),
  }),

  // ── Fights ────────────────────────────────────────────────────────────────
  fights: router({
    byEvent: publicProcedure
      .input(z.object({ eventId: z.number() }))
      .query(async ({ input }) => {
        return db.getFightsByEvent(input.eventId);
      }),

    byEventWithPredictions: protectedProcedure
      .input(z.object({ eventId: z.number() }))
      .query(async ({ ctx, input }) => {
        const fightList = await db.getFightsByEvent(input.eventId);
        const results = await Promise.all(
          fightList.map(async (fight) => {
            const pred = await db.getPredictionByUserAndFight(ctx.user.id, fight.id);
            return {
              ...fight,
              userPrediction: pred
                ? {
                    id: pred.id,
                    pickedWinner: pred.pickedWinner,
                    pickedFinishType: pred.pickedFinishType,
                    pickedMethod: pred.pickedMethod,
                    isLocked: pred.isLocked,
                    status: pred.status,
                    totalPoints: pred.totalPoints,
                  }
                : null,
            };
          }),
        );
        return results;
      }),

    getById: publicProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => {
        return db.getFightById(input.id);
      }),

    create: protectedProcedure
      .input(z.object({
        eventId: z.number(),
        fighter1Name: z.string(),
        fighter1Record: z.string().optional(),
        fighter2Name: z.string(),
        fighter2Record: z.string().optional(),
        weightClass: z.string().optional(),
        cardSection: z.enum(["main", "prelim", "early_prelim"]).default("main"),
        isTitleFight: z.boolean().default(false),
        isMainEvent: z.boolean().default(false),
        odds1: z.number().optional(),
        odds2: z.number().optional(),
        scheduledStartTime: z.string().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        if (ctx.user.role !== "admin") throw new Error("Admin only");
        return db.createFight({
          ...input,
          scheduledStartTime: input.scheduledStartTime ? new Date(input.scheduledStartTime) : undefined,
        });
      }),

    resolve: protectedProcedure
      .input(z.object({
        fightId: z.number(),
        winner: z.string(),
        finishType: z.enum(["finish", "decision"]),
        method: z.enum(["tko_ko", "submission", "decision", "draw", "nc"]),
        round: z.number().optional(),
        fightTime: z.string().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        if (ctx.user.role !== "admin") throw new Error("Admin only");

        await db.resolveFight(input.fightId, input.winner, input.finishType, input.method, input.round, input.fightTime);

        const fight = await db.getFightById(input.fightId);
        if (!fight) throw new Error("Fight not found");

        const allPredictions = await db.getPredictionsForFight(input.fightId);

        for (const pred of allPredictions) {
          const pickedFighter1 = pred.pickedWinner === fight.fighter1Name;
          const pickedOdds = pickedFighter1 ? fight.odds1 : fight.odds2;

          const breakdown = calculateCredibility(
            { pickedWinner: pred.pickedWinner, pickedFinishType: pred.pickedFinishType, pickedMethod: pred.pickedMethod },
            { winner: input.winner, finishType: input.finishType, method: input.method },
            pickedOdds ?? null,
          );

          const correctWinner = pred.pickedWinner === input.winner;
          const correctFinish = pred.pickedFinishType === input.finishType;
          const correctMethod =
            input.finishType === "finish" &&
            pred.pickedFinishType === "finish" &&
            pred.pickedMethod != null &&
            ((input.method === "tko_ko" && pred.pickedMethod === "tko_ko") ||
              (input.method === "submission" && pred.pickedMethod === "submission"));

          let status: "correct" | "wrong" | "partial" = "wrong";
          if (correctWinner && correctFinish && (input.finishType === "decision" || correctMethod)) {
            status = "correct";
          } else if (correctWinner || correctFinish) {
            status = "partial";
          }

          const drizzleDb = await db.getDb();
          if (drizzleDb) {
            const { predictions: predsTable } = await import("../drizzle/schema");
            const { eq } = await import("drizzle-orm");
            await drizzleDb.update(predsTable).set({
              status,
              winnerPoints: breakdown.winnerPoints,
              finishTypePoints: breakdown.finishTypePoints,
              methodPoints: breakdown.methodPoints,
              bonusPoints: breakdown.underdogBonus + breakdown.perfectPickBonus,
              totalPoints: breakdown.totalPoints,
            }).where(eq(predsTable.id, pred.id));
          }

          await db.insertCredibilityLog({
            userId: pred.userId,
            fightId: input.fightId,
            predictionId: pred.id,
            winnerPoints: breakdown.winnerPoints,
            finishTypePoints: breakdown.finishTypePoints,
            methodPoints: breakdown.methodPoints,
            bonusPoints: breakdown.underdogBonus + breakdown.perfectPickBonus,
            totalPoints: breakdown.totalPoints,
            breakdown: JSON.stringify(breakdown),
          });

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

        return { success: true, predictionsResolved: allPredictions.length };
      }),

    lock: protectedProcedure
      .input(z.object({ fightId: z.number() }))
      .mutation(async ({ ctx, input }) => {
        if (ctx.user.role !== "admin") throw new Error("Admin only");
        await db.lockPredictionsForFight(input.fightId);
        const drizzleDb = await db.getDb();
        if (drizzleDb) {
          const { fights: fightsTable } = await import("../drizzle/schema");
          const { eq } = await import("drizzle-orm");
          await drizzleDb.update(fightsTable).set({ status: "live" }).where(eq(fightsTable.id, input.fightId));
        }
        return { success: true };
      }),
  }),

  // ── Predictions ───────────────────────────────────────────────────────────
  predictions: router({
    myPredictions: protectedProcedure.query(async ({ ctx }) => {
      return db.getUserPredictions(ctx.user.id);
    }),

    forFight: protectedProcedure
      .input(z.object({ fightId: z.number() }))
      .query(async ({ ctx, input }) => {
        return db.getPredictionByUserAndFight(ctx.user.id, input.fightId);
      }),

    submit: protectedProcedure
      .input(z.object({
        fightId: z.number(),
        pickedWinner: z.string(),
        pickedFinishType: z.enum(["finish", "decision"]).optional(),
        pickedMethod: z.enum(["tko_ko", "submission"]).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const fight = await db.getFightById(input.fightId);
        if (!fight) throw new Error("Fight not found");
        if (fight.status === "live" || fight.status === "completed") {
          throw new Error("Cannot predict — fight has already started");
        }

        const pickedFighter1 = input.pickedWinner === fight.fighter1Name;
        const oddsAtPrediction = pickedFighter1 ? fight.odds1 : fight.odds2;

        return db.upsertPrediction(ctx.user.id, input.fightId, {
          pickedWinner: input.pickedWinner,
          pickedFinishType: input.pickedFinishType,
          pickedMethod: input.pickedMethod,
          oddsAtPrediction: oddsAtPrediction ?? undefined,
        });
      }),
  }),

  // ── Leaderboard ───────────────────────────────────────────────────────────
  leaderboard: router({
    global: publicProcedure
      .input(z.object({ limit: z.number().default(50) }))
      .query(async ({ input }) => {
        return db.getLeaderboard(input.limit);
      }),
    byEvent: publicProcedure
      .input(z.object({ eventId: z.number(), limit: z.number().default(50) }))
      .query(async ({ input }) => {
        return db.getEventLeaderboard(input.eventId, input.limit);
      }),
    eventStats: publicProcedure
      .input(z.object({ eventId: z.number() }))
      .query(async ({ input }) => {
        return db.getEventPredictionStats(input.eventId);
      }),
  }),

  // ── Odds ──────────────────────────────────────────────────────────────────
  odds: router({
    fetchLive: publicProcedure.query(async () => {
      return fetchMMAOdds();
    }),
  }),

  // ── Admin ─────────────────────────────────────────────────────────────────
  admin: router({
    // Verify admin token (used by the admin screen to gate access)
    verifyToken: publicProcedure
      .input(z.object({ token: z.string() }))
      .query(async ({ input }) => {
        const validToken = ENV.adminToken;
        if (!validToken || input.token !== validToken) {
          throw new Error("Invalid admin token");
        }
        return { valid: true };
      }),

    // Dashboard stats
    stats: publicProcedure
      .input(z.object({ token: z.string() }))
      .query(async ({ input }) => {
        if (!ENV.adminToken || input.token !== ENV.adminToken) throw new Error("Unauthorized");
        return db.getAdminStats();
      }),

    // All registered users with their profiles
    users: publicProcedure
      .input(z.object({ token: z.string() }))
      .query(async ({ input }) => {
        if (!ENV.adminToken || input.token !== ENV.adminToken) throw new Error("Unauthorized");
        return db.getAdminUserList();
      }),

    // All fights with prediction counts
    fights: publicProcedure
      .input(z.object({ token: z.string() }))
      .query(async ({ input }) => {
        if (!ENV.adminToken || input.token !== ENV.adminToken) throw new Error("Unauthorized");
        return db.getAdminFightList();
      }),

    // User activity (all predictions for a specific user)
    userActivity: publicProcedure
      .input(z.object({ token: z.string(), userId: z.number() }))
      .query(async ({ input }) => {
        if (!ENV.adminToken || input.token !== ENV.adminToken) throw new Error("Unauthorized");
        return db.getAdminUserActivity(input.userId);
      }),

    // Manually resolve a fight (admin override)
    resolveFight: publicProcedure
      .input(z.object({
        token: z.string(),
        fightId: z.number(),
        winner: z.string(),
        finishType: z.enum(["finish", "decision"]),
        method: z.enum(["tko_ko", "submission", "decision", "draw", "nc"]),
        round: z.number().optional(),
        fightTime: z.string().optional(),
      }))
      .mutation(async ({ input }) => {
        if (!ENV.adminToken || input.token !== ENV.adminToken) throw new Error("Unauthorized");

        await db.resolveFight(input.fightId, input.winner, input.finishType, input.method, input.round, input.fightTime);

        const fight = await db.getFightById(input.fightId);
        if (!fight) throw new Error("Fight not found");

        const allPredictions = await db.getPredictionsForFight(input.fightId);

        for (const pred of allPredictions) {
          const pickedFighter1 = pred.pickedWinner === fight.fighter1Name;
          const pickedOdds = pickedFighter1 ? fight.odds1 : fight.odds2;

          const breakdown = calculateCredibility(
            { pickedWinner: pred.pickedWinner, pickedFinishType: pred.pickedFinishType, pickedMethod: pred.pickedMethod },
            { winner: input.winner, finishType: input.finishType, method: input.method },
            pickedOdds ?? null,
          );

          const correctWinner = pred.pickedWinner === input.winner;
          const correctFinish = pred.pickedFinishType === input.finishType;
          const correctMethod =
            input.finishType === "finish" &&
            pred.pickedFinishType === "finish" &&
            pred.pickedMethod != null &&
            ((input.method === "tko_ko" && pred.pickedMethod === "tko_ko") ||
              (input.method === "submission" && pred.pickedMethod === "submission"));

          let status: "correct" | "wrong" | "partial" = "wrong";
          if (correctWinner && correctFinish && (input.finishType === "decision" || correctMethod)) {
            status = "correct";
          } else if (correctWinner || correctFinish) {
            status = "partial";
          }

          const drizzleDb = await db.getDb();
          if (drizzleDb) {
            const { predictions: predsTable } = await import("../drizzle/schema");
            const { eq } = await import("drizzle-orm");
            await drizzleDb.update(predsTable).set({
              status,
              winnerPoints: breakdown.winnerPoints,
              finishTypePoints: breakdown.finishTypePoints,
              methodPoints: breakdown.methodPoints,
              bonusPoints: breakdown.underdogBonus + breakdown.perfectPickBonus,
              totalPoints: breakdown.totalPoints,
            }).where(eq(predsTable.id, pred.id));
          }

          await db.insertCredibilityLog({
            userId: pred.userId,
            fightId: input.fightId,
            predictionId: pred.id,
            winnerPoints: breakdown.winnerPoints,
            finishTypePoints: breakdown.finishTypePoints,
            methodPoints: breakdown.methodPoints,
            bonusPoints: breakdown.underdogBonus + breakdown.perfectPickBonus,
            totalPoints: breakdown.totalPoints,
            breakdown: JSON.stringify(breakdown),
          });

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

        return { success: true, predictionsResolved: allPredictions.length };
      }),

    // Lock all predictions for a fight
    lockFight: publicProcedure
      .input(z.object({ token: z.string(), fightId: z.number() }))
      .mutation(async ({ input }) => {
        if (!ENV.adminToken || input.token !== ENV.adminToken) throw new Error("Unauthorized");
        await db.lockPredictionsForFight(input.fightId);
        const drizzleDb = await db.getDb();
        if (drizzleDb) {
          const { fights: fightsTable } = await import("../drizzle/schema");
          const { eq } = await import("drizzle-orm");
          await drizzleDb.update(fightsTable).set({ status: "live" }).where(eq(fightsTable.id, input.fightId));
        }
        return { success: true };
      }),

    // Manually trigger the result poller
    triggerPoll: publicProcedure
      .input(z.object({ token: z.string() }))
      .mutation(async ({ input }) => {
        if (!ENV.adminToken || input.token !== ENV.adminToken) throw new Error("Unauthorized");
        const result = await pollFightResults();
        return result;
      }),

    // Update event status
    updateEventStatus: publicProcedure
      .input(z.object({
        token: z.string(),
        eventId: z.number(),
        status: z.enum(["upcoming", "live", "completed"]),
      }))
      .mutation(async ({ input }) => {
        if (!ENV.adminToken || input.token !== ENV.adminToken) throw new Error("Unauthorized");
        await db.upsertEvent({ id: input.eventId, name: "", eventDate: new Date(), status: input.status });
        return { success: true };
      }),
  }),
});

export type AppRouter = typeof appRouter;
