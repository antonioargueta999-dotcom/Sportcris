CREATE TABLE "daily_analyses" (
	"date" text PRIMARY KEY,
	"games" jsonb NOT NULL,
	"game_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
