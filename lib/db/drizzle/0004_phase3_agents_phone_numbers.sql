CREATE TABLE "agent_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"business_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"version_number" integer NOT NULL,
	"retell_version" integer,
	"snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"published_by_user_id" text,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"business_id" text NOT NULL,
	"created_by_user_id" text,
	"name" text NOT NULL,
	"use_case" text DEFAULT 'real_estate_qualifier' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"language" text DEFAULT 'en-US' NOT NULL,
	"retell_agent_id" text,
	"retell_llm_id" text,
	"published_version" integer,
	"voice_id" text,
	"voice_model" text,
	"voice_speed" numeric DEFAULT '1.0',
	"voice_temperature" numeric DEFAULT '0.0',
	"greeting" text DEFAULT '' NOT NULL,
	"system_prompt" text DEFAULT '' NOT NULL,
	"fallback_message" text DEFAULT 'Let me connect you with a team member who can help.' NOT NULL,
	"qualification_questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"escalation_rules" text DEFAULT 'Transfer questions outside approved business information to a human.' NOT NULL,
	"tools_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"call_behavior" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"working_days" text[] DEFAULT '{"Mon","Tue","Wed","Thu","Fri"}' NOT NULL,
	"hours_start" text DEFAULT '09:00' NOT NULL,
	"hours_end" text DEFAULT '21:00' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "phone_numbers" (
	"id" text PRIMARY KEY NOT NULL,
	"business_id" text NOT NULL,
	"provider" text DEFAULT 'retell' NOT NULL,
	"e164_number" text NOT NULL,
	"nickname" text,
	"market" text DEFAULT 'US' NOT NULL,
	"inbound_agent_id" text,
	"outbound_agent_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"retell_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "phone_numbers_e164_number_unique" UNIQUE("e164_number")
);
--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "agent_id" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "phone_number_id" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "direction" text DEFAULT 'outbound' NOT NULL;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "caller_number" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "destination_number" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "transcript" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "transcript_json" jsonb;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "recording_url" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "disconnection_reason" text;--> statement-breakpoint
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_published_by_user_id_users_id_fk" FOREIGN KEY ("published_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_numbers" ADD CONSTRAINT "phone_numbers_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_numbers" ADD CONSTRAINT "phone_numbers_inbound_agent_id_agents_id_fk" FOREIGN KEY ("inbound_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_numbers" ADD CONSTRAINT "phone_numbers_outbound_agent_id_agents_id_fk" FOREIGN KEY ("outbound_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_business_retell_agent_unique" ON "agents" USING btree ("business_id","retell_agent_id");--> statement-breakpoint
CREATE INDEX "agents_business_status_idx" ON "agents" USING btree ("business_id","status");--> statement-breakpoint
CREATE INDEX "phone_numbers_business_idx" ON "phone_numbers" USING btree ("business_id");