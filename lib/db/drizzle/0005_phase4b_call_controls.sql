ALTER TABLE "calls" ADD COLUMN "connected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "metadata" jsonb DEFAULT '{}'::jsonb;
