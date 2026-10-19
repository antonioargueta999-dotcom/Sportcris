import { pgTable, text, jsonb, integer, timestamp, serial, real } from "drizzle-orm/pg-core";

// One row per calendar day (YYYY-MM-DD) holding that day's full slate of analyzed games
export const dailyAnalyses = pgTable("daily_analyses", {
  date: text().primaryKey(),
  games: jsonb().notNull(),
  gameCount: integer("game_count").notNull().default(0),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Reto Escalera: each attempt starts at $10 and aims for $1000; a loss ends it ('active' | 'lost' | 'won' | 'abandoned')
export const ladderAttempts = pgTable("ladder_attempts", {
  id: serial().primaryKey(),
  status: text().notNull().default("active"),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  endedAt: timestamp("ended_at"),
});

// One rung of the ladder: the pick played that day and its outcome ('win' | 'loss' | 'push', null while pending)
export const ladderSteps = pgTable("ladder_steps", {
  id: serial().primaryKey(),
  attemptId: integer("attempt_id").notNull().references(() => ladderAttempts.id, { onDelete: "cascade" }),
  date: text().notNull(),
  bankBefore: real("bank_before").notNull(),
  stake: real().notNull(),
  pick: jsonb().notNull(),
  result: text(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
