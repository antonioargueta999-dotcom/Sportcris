CREATE TABLE "ladder_attempts" (
	"id" serial PRIMARY KEY,
	"status" text DEFAULT 'active' NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"ended_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "ladder_steps" (
	"id" serial PRIMARY KEY,
	"attempt_id" integer NOT NULL,
	"date" text NOT NULL,
	"bank_before" real NOT NULL,
	"stake" real NOT NULL,
	"pick" jsonb NOT NULL,
	"result" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ladder_steps" ADD CONSTRAINT "ladder_steps_attempt_id_ladder_attempts_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "ladder_attempts"("id") ON DELETE CASCADE;