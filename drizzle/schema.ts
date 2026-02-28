import {
  boolean,
  int,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core";

// ─── Users (built-in auth table) ─────────────────────────────────────────────
export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

// ─── User Profiles ────────────────────────────────────────────────────────────
export const userProfiles = mysqlTable("user_profiles", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull().unique(),
  username: varchar("username", { length: 64 }).notNull().unique(),
  displayName: varchar("displayName", { length: 128 }),
  credibilityScore: int("credibilityScore").default(0).notNull(),
  tier: mysqlEnum("tier", ["rookie", "contender", "champion", "goat"])
    .default("rookie")
    .notNull(),
  totalPicks: int("totalPicks").default(0).notNull(),
  correctPicks: int("correctPicks").default(0).notNull(),
  correctFinishPicks: int("correctFinishPicks").default(0).notNull(),
  totalFinishPicks: int("totalFinishPicks").default(0).notNull(),
  correctMethodPicks: int("correctMethodPicks").default(0).notNull(),
  totalMethodPicks: int("totalMethodPicks").default(0).notNull(),
  correctUnderdogPicks: int("correctUnderdogPicks").default(0).notNull(),
  totalUnderdogPicks: int("totalUnderdogPicks").default(0).notNull(),
  currentStreak: int("currentStreak").default(0).notNull(),
  bestStreak: int("bestStreak").default(0).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

// ─── UFC Events ───────────────────────────────────────────────────────────────
export const events = mysqlTable("events", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  shortName: varchar("shortName", { length: 128 }),
  eventDate: timestamp("eventDate").notNull(),
  venue: varchar("venue", { length: 255 }),
  location: varchar("location", { length: 255 }),
  status: mysqlEnum("status", ["upcoming", "live", "completed"]).default("upcoming").notNull(),
  ufcEventId: varchar("ufcEventId", { length: 128 }),
  imageUrl: text("imageUrl"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

// ─── Fights ───────────────────────────────────────────────────────────────────
export const fights = mysqlTable("fights", {
  id: int("id").autoincrement().primaryKey(),
  eventId: int("eventId").notNull(),
  fighter1Name: varchar("fighter1Name", { length: 128 }).notNull(),
  fighter1Record: varchar("fighter1Record", { length: 32 }),
  fighter1ImageUrl: text("fighter1ImageUrl"),
  fighter1Nationality: varchar("fighter1Nationality", { length: 64 }),
  fighter1Nickname: varchar("fighter1Nickname", { length: 64 }),
  fighter1RecentResults: text("fighter1RecentResults"), // JSON array of last 5 results
  fighter1Ranking: varchar("fighter1Ranking", { length: 16 }),
  fighter2Name: varchar("fighter2Name", { length: 128 }).notNull(),
  fighter2Record: varchar("fighter2Record", { length: 32 }),
  fighter2ImageUrl: text("fighter2ImageUrl"),
  fighter2Nationality: varchar("fighter2Nationality", { length: 64 }),
  fighter2Nickname: varchar("fighter2Nickname", { length: 64 }),
  fighter2RecentResults: text("fighter2RecentResults"), // JSON array of last 5 results
  fighter2Ranking: varchar("fighter2Ranking", { length: 16 }),
  weightClass: varchar("weightClass", { length: 64 }),
  cardSection: mysqlEnum("cardSection", ["main", "prelim", "early_prelim"]).default("main").notNull(),
  isTitleFight: boolean("isTitleFight").default(false).notNull(),
  isMainEvent: boolean("isMainEvent").default(false).notNull(),
  odds1: int("odds1"),
  odds2: int("odds2"),
  oddsUpdatedAt: timestamp("oddsUpdatedAt"),
  status: mysqlEnum("status", ["upcoming", "live", "completed", "cancelled"]).default("upcoming").notNull(),
  scheduledStartTime: timestamp("scheduledStartTime"),
  winner: varchar("winner", { length: 128 }),
  finishType: mysqlEnum("finishType", ["finish", "decision"]),
  method: mysqlEnum("method", ["tko_ko", "submission", "decision", "draw", "nc"]),
  round: int("round"),
  fightTime: varchar("fightTime", { length: 16 }),
  oddsApiEventId: varchar("oddsApiEventId", { length: 255 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

// ─── Predictions ──────────────────────────────────────────────────────────────
export const predictions = mysqlTable("predictions", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  fightId: int("fightId").notNull(),
  pickedWinner: varchar("pickedWinner", { length: 128 }).notNull(),
  pickedFinishType: mysqlEnum("pickedFinishType", ["finish", "decision"]),
  pickedMethod: mysqlEnum("pickedMethod", ["tko_ko", "submission"]),
  isLocked: boolean("isLocked").default(false).notNull(),
  status: mysqlEnum("status", ["pending", "correct", "wrong", "partial"]).default("pending").notNull(),
  winnerPoints: int("winnerPoints").default(0).notNull(),
  finishTypePoints: int("finishTypePoints").default(0).notNull(),
  methodPoints: int("methodPoints").default(0).notNull(),
  bonusPoints: int("bonusPoints").default(0).notNull(),
  totalPoints: int("totalPoints").default(0).notNull(),
  oddsAtPrediction: int("oddsAtPrediction"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

// ─── Fighter Stats (per user) ─────────────────────────────────────────────────
export const userFighterStats = mysqlTable("user_fighter_stats", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  fighterName: varchar("fighterName", { length: 128 }).notNull(),
  totalPicks: int("totalPicks").default(0).notNull(),
  correctPicks: int("correctPicks").default(0).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

// ─── Credibility Log ──────────────────────────────────────────────────────────
export const credibilityLog = mysqlTable("credibility_log", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  fightId: int("fightId").notNull(),
  predictionId: int("predictionId").notNull(),
  winnerPoints: int("winnerPoints").default(0).notNull(),
  finishTypePoints: int("finishTypePoints").default(0).notNull(),
  methodPoints: int("methodPoints").default(0).notNull(),
  bonusPoints: int("bonusPoints").default(0).notNull(),
  totalPoints: int("totalPoints").default(0).notNull(),
  breakdown: text("breakdown"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// ─── Types ────────────────────────────────────────────────────────────────────
export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
export type UserProfile = typeof userProfiles.$inferSelect;
export type InsertUserProfile = typeof userProfiles.$inferInsert;
export type Event = typeof events.$inferSelect;
export type InsertEvent = typeof events.$inferInsert;
export type Fight = typeof fights.$inferSelect;
export type InsertFight = typeof fights.$inferInsert;
export type Prediction = typeof predictions.$inferSelect;
export type InsertPrediction = typeof predictions.$inferInsert;
export type UserFighterStat = typeof userFighterStats.$inferSelect;
export type CredibilityLog = typeof credibilityLog.$inferSelect;
