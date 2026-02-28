import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import {
  credibilityLog,
  events,
  fights,
  predictions,
  userFighterStats,
  userProfiles,
  users,
  type Event,
  type Fight,
  type InsertEvent,
  type InsertFight,
  type InsertPrediction,
  type InsertUser,
  type InsertUserProfile,
  type Prediction,
  type UserProfile,
} from "../drizzle/schema";
import { ENV } from "./_core/env";

let _db: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

// ─── Core Auth ────────────────────────────────────────────────────────────────

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await getDb();
  if (!db) { console.warn("[Database] Cannot upsert user: database not available"); return; }
  try {
    const values: InsertUser = { openId: user.openId };
    const updateSet: Record<string, unknown> = {};
    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];
    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };
    textFields.forEach(assignNullable);
    if (user.lastSignedIn !== undefined) { values.lastSignedIn = user.lastSignedIn; updateSet.lastSignedIn = user.lastSignedIn; }
    if (user.role !== undefined) { values.role = user.role; updateSet.role = user.role; }
    else if (user.openId === ENV.ownerOpenId) { values.role = "admin"; updateSet.role = "admin"; }
    if (!values.lastSignedIn) values.lastSignedIn = new Date();
    if (Object.keys(updateSet).length === 0) updateSet.lastSignedIn = new Date();
    await db.insert(users).values(values).onDuplicateKeyUpdate({ set: updateSet });
  } catch (error) { console.error("[Database] Failed to upsert user:", error); throw error; }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) { console.warn("[Database] Cannot get user: database not available"); return undefined; }
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

// ─── User Profiles ────────────────────────────────────────────────────────────

export async function getUserProfile(userId: number): Promise<UserProfile | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(userProfiles).where(eq(userProfiles.userId, userId));
  return rows[0] ?? null;
}

export async function getProfileByUsername(username: string): Promise<UserProfile | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(userProfiles).where(eq(userProfiles.username, username));
  return rows[0] ?? null;
}

export async function createUserProfile(data: InsertUserProfile): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db.insert(userProfiles).values(data);
  return result[0].insertId;
}

export async function updateUserProfile(userId: number, data: Partial<InsertUserProfile>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(userProfiles).set(data).where(eq(userProfiles.userId, userId));
}

export async function getLeaderboard(limit = 50) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(userProfiles).orderBy(desc(userProfiles.credibilityScore)).limit(limit);
}

// ─── Events ───────────────────────────────────────────────────────────────────

export async function getUpcomingEvents(): Promise<Event[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(events).where(eq(events.status, "upcoming")).orderBy(events.eventDate);
}

export async function getAllEvents(): Promise<Event[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(events).orderBy(asc(events.eventDate));
}

export async function getEventById(id: number): Promise<Event | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(events).where(eq(events.id, id));
  return rows[0] ?? null;
}

export async function upsertEvent(data: InsertEvent & { id?: number }) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  if (data.id) {
    const { id, ...rest } = data;
    await db.update(events).set(rest).where(eq(events.id, id));
    return id;
  }
  const result = await db.insert(events).values(data);
  return result[0].insertId;
}

// ─── Fights ───────────────────────────────────────────────────────────────────

export async function getFightsByEvent(eventId: number): Promise<Fight[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(fights).where(eq(fights.eventId, eventId));
}

export async function getFightById(id: number): Promise<Fight | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(fights).where(eq(fights.id, id));
  return rows[0] ?? null;
}

export async function createFight(data: InsertFight): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db.insert(fights).values(data);
  return result[0].insertId;
}

export async function updateFightOdds(fightId: number, odds1: number, odds2: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(fights).set({ odds1, odds2, oddsUpdatedAt: new Date() }).where(eq(fights.id, fightId));
}

export async function resolveFight(
  fightId: number,
  winner: string,
  finishType: "finish" | "decision",
  method: "tko_ko" | "submission" | "decision" | "draw" | "nc",
  round?: number,
  fightTime?: string,
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(fights).set({ winner, finishType, method, round, fightTime, status: "completed" }).where(eq(fights.id, fightId));
}

// ─── Predictions ──────────────────────────────────────────────────────────────

export async function getUserPredictions(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select({ prediction: predictions, fight: fights, event: events })
    .from(predictions)
    .innerJoin(fights, eq(predictions.fightId, fights.id))
    .innerJoin(events, eq(fights.eventId, events.id))
    .where(eq(predictions.userId, userId))
    .orderBy(desc(events.eventDate));
}

export async function getPredictionByUserAndFight(userId: number, fightId: number): Promise<Prediction | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(predictions).where(and(eq(predictions.userId, userId), eq(predictions.fightId, fightId)));
  return rows[0] ?? null;
}

export async function upsertPrediction(userId: number, fightId: number, data: Omit<InsertPrediction, "userId" | "fightId">): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const existing = await getPredictionByUserAndFight(userId, fightId);
  if (existing) {
    if (existing.isLocked) throw new Error("Prediction is locked — fight has started");
    await db.update(predictions).set({ ...data, updatedAt: new Date() }).where(eq(predictions.id, existing.id));
    return existing.id;
  }
  const result = await db.insert(predictions).values({ userId, fightId, ...data });
  return result[0].insertId;
}

export async function lockPredictionsForFight(fightId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(predictions).set({ isLocked: true }).where(eq(predictions.fightId, fightId));
}

export async function getPredictionsForFight(fightId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(predictions).where(eq(predictions.fightId, fightId));
}

// ─── Credibility Scoring ──────────────────────────────────────────────────────

export async function insertCredibilityLog(data: {
  userId: number; fightId: number; predictionId: number;
  winnerPoints: number; finishTypePoints: number; methodPoints: number;
  bonusPoints: number; totalPoints: number; breakdown: string;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.insert(credibilityLog).values(data);
}

export async function getCredibilityLog(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(credibilityLog).where(eq(credibilityLog.userId, userId)).orderBy(desc(credibilityLog.createdAt));
}

// ─── Fighter Stats ────────────────────────────────────────────────────────────

export async function getUserFighterStats(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(userFighterStats).where(eq(userFighterStats.userId, userId)).orderBy(desc(userFighterStats.totalPicks));
}

export async function upsertFighterStat(userId: number, fighterName: string, correct: boolean) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const existing = await db.select().from(userFighterStats).where(and(eq(userFighterStats.userId, userId), eq(userFighterStats.fighterName, fighterName)));
  if (existing.length > 0) {
    await db.update(userFighterStats).set({
      totalPicks: sql`${userFighterStats.totalPicks} + 1`,
      correctPicks: correct ? sql`${userFighterStats.correctPicks} + 1` : sql`${userFighterStats.correctPicks}`,
    }).where(eq(userFighterStats.id, existing[0].id));
  } else {
    await db.insert(userFighterStats).values({ userId, fighterName, totalPicks: 1, correctPicks: correct ? 1 : 0 });
  }
}

// ─── Admin Queries ────────────────────────────────────────────────────────────

export async function getAdminUserList() {
  const db = await getDb();
  if (!db) return [];
  // Join users with their profiles and prediction counts
  const userList = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      loginMethod: users.loginMethod,
      role: users.role,
      createdAt: users.createdAt,
      lastSignedIn: users.lastSignedIn,
      username: userProfiles.username,
      displayName: userProfiles.displayName,
      credibilityScore: userProfiles.credibilityScore,
      tier: userProfiles.tier,
      totalPicks: userProfiles.totalPicks,
      correctPicks: userProfiles.correctPicks,
      currentStreak: userProfiles.currentStreak,
    })
    .from(users)
    .leftJoin(userProfiles, eq(users.id, userProfiles.userId))
    .orderBy(desc(users.createdAt));
  return userList;
}

export async function getAdminStats() {
  const db = await getDb();
  if (!db) return null;

  const [totalUsers] = await db.select({ count: count() }).from(users);
  const [totalProfiles] = await db.select({ count: count() }).from(userProfiles);
  const [totalPredictions] = await db.select({ count: count() }).from(predictions);
  const [totalEvents] = await db.select({ count: count() }).from(events);
  const [totalFights] = await db.select({ count: count() }).from(fights);
  const [pendingFights] = await db.select({ count: count() }).from(fights).where(eq(fights.status, "upcoming"));
  const [completedFights] = await db.select({ count: count() }).from(fights).where(eq(fights.status, "completed"));

  return {
    totalUsers: totalUsers.count,
    totalProfiles: totalProfiles.count,
    totalPredictions: totalPredictions.count,
    totalEvents: totalEvents.count,
    totalFights: totalFights.count,
    pendingFights: pendingFights.count,
    completedFights: completedFights.count,
  };
}

export async function getAdminFightList() {
  const db = await getDb();
  if (!db) return [];
  return db
    .select({
      fight: fights,
      event: events,
      predictionCount: sql<number>`(SELECT COUNT(*) FROM predictions WHERE predictions.fightId = ${fights.id})`,
    })
    .from(fights)
    .innerJoin(events, eq(fights.eventId, events.id))
    .orderBy(desc(events.eventDate), fights.cardSection);
}

export async function getAdminUserActivity(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select({ prediction: predictions, fight: fights, event: events })
    .from(predictions)
    .innerJoin(fights, eq(predictions.fightId, fights.id))
    .innerJoin(events, eq(fights.eventId, events.id))
    .where(eq(predictions.userId, userId))
    .orderBy(desc(predictions.createdAt));
}

// ─── Event Leaderboard ────────────────────────────────────────────────────────

export async function getEventLeaderboard(eventId: number, limit = 50) {
  const db = await getDb();
  if (!db) return [];

  // Aggregate credibility earned per user for all fights in this event
  const rows = await db
    .select({
      userId: credibilityLog.userId,
      totalEarned: sql<number>`SUM(${credibilityLog.totalPoints})`,
      correctPicks: sql<number>`SUM(CASE WHEN p.status = 'correct' THEN 1 ELSE 0 END)`,
      partialPicks: sql<number>`SUM(CASE WHEN p.status = 'partial' THEN 1 ELSE 0 END)`,
      totalPicks: sql<number>`COUNT(DISTINCT ${credibilityLog.predictionId})`,
      perfectPicks: sql<number>`SUM(CASE WHEN p.winnerPoints > 0 AND p.finishTypePoints > 0 AND p.methodPoints > 0 AND p.bonusPoints > 0 THEN 1 ELSE 0 END)`,
    })
    .from(credibilityLog)
    .innerJoin(fights, eq(credibilityLog.fightId, fights.id))
    .innerJoin(predictions, eq(credibilityLog.predictionId, predictions.id))
    .where(eq(fights.eventId, eventId))
    .groupBy(credibilityLog.userId)
    .orderBy(desc(sql<number>`SUM(${credibilityLog.totalPoints})`))
    .limit(limit);

  // Alias for join
  const p = predictions;

  // Fetch profiles for these users
  if (rows.length === 0) return [];
  const userIds = rows.map((r) => r.userId);
  const profiles = await db
    .select({
      userId: userProfiles.userId,
      username: userProfiles.username,
      displayName: userProfiles.displayName,
      tier: userProfiles.tier,
      credibilityScore: userProfiles.credibilityScore,
    })
    .from(userProfiles)
    .where(inArray(userProfiles.userId, userIds));

  const profileMap = new Map(profiles.map((p) => [p.userId, p]));

  return rows.map((row, index) => ({
    rank: index + 1,
    userId: row.userId,
    username: profileMap.get(row.userId)?.username ?? `user_${row.userId}`,
    displayName: profileMap.get(row.userId)?.displayName ?? null,
    tier: profileMap.get(row.userId)?.tier ?? "rookie",
    totalCredibilityScore: profileMap.get(row.userId)?.credibilityScore ?? 0,
    eventCredibilityEarned: row.totalEarned ?? 0,
    correctPicks: row.correctPicks ?? 0,
    partialPicks: row.partialPicks ?? 0,
    totalPicks: row.totalPicks ?? 0,
    perfectPicks: row.perfectPicks ?? 0,
    accuracy:
      row.totalPicks > 0
        ? Math.round(((row.correctPicks ?? 0) / row.totalPicks) * 100)
        : 0,
  }));
}

export async function getEventPredictionStats(eventId: number) {
  const db = await getDb();
  if (!db) return { totalPredictors: 0, scoredFights: 0, totalFights: 0 };

  const [totalFightsRow] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(fights)
    .where(eq(fights.eventId, eventId));

  const [scoredFightsRow] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(fights)
    .where(and(eq(fights.eventId, eventId), eq(fights.status, "completed")));

  const [predictorsRow] = await db
    .select({ count: sql<number>`COUNT(DISTINCT p.userId)` })
    .from(predictions)
    .innerJoin(fights, eq(predictions.fightId, fights.id))
    .where(eq(fights.eventId, eventId));

  return {
    totalPredictors: predictorsRow?.count ?? 0,
    scoredFights: scoredFightsRow?.count ?? 0,
    totalFights: totalFightsRow?.count ?? 0,
  };
}
