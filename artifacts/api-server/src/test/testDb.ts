/**
 * Real-database test harness.
 *
 * The highest-risk behaviour in LeadSprint is not pure logic — it is
 * idempotency, tenant scoping and the order of the safety gates, all of
 * which live in SQL constraints and multi-statement flows. Unit-testing
 * around a mocked `db` would prove none of it, so these tests run against
 * a genuine embedded PostgreSQL (PGlite) with the production schema.
 */

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@workspace/db/schema";

export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

const DDL = `
CREATE TABLE businesses (
  id text PRIMARY KEY,
  name text NOT NULL,
  slug text UNIQUE,
  market text NOT NULL DEFAULT 'US',
  timezone text NOT NULL DEFAULT 'America/New_York',
  phone_number text NOT NULL,
  transfer_number text NOT NULL,
  recording_disclosure boolean NOT NULL DEFAULT true,
  ai_disclosure boolean NOT NULL DEFAULT true,
  quiet_hours text NOT NULL DEFAULT '21:00–08:00',
  max_call_attempts integer NOT NULL DEFAULT 2,
  suppression_enabled boolean NOT NULL DEFAULT true,
  project_name text NOT NULL,
  services_or_property_types text[] NOT NULL DEFAULT '{}',
  approved_faq text NOT NULL DEFAULT '',
  qualification_questions text[] NOT NULL DEFAULT '{}',
  escalation_rules text NOT NULL DEFAULT 'Transfer questions outside approved business information to a human.',
  cal_event_type_id text,
  retell_agent_id text,
  vertical text NOT NULL DEFAULT 'real_estate',
  notify_email text,
  service_area_zips jsonb NOT NULL DEFAULT '[]'::jsonb,
  pricing_policy text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE users (
  id text PRIMARY KEY,
  business_id text NOT NULL REFERENCES businesses(id),
  name text NOT NULL,
  email text NOT NULL,
  role text NOT NULL DEFAULT 'owner',
  last_login_at timestamptz
);
CREATE TABLE contacts (
  id text PRIMARY KEY,
  business_id text NOT NULL REFERENCES businesses(id),
  name text NOT NULL,
  phone text NOT NULL,
  email text,
  preferred_language text NOT NULL DEFAULT 'en',
  consent_status text NOT NULL DEFAULT 'unknown',
  consent_source text,
  consent_at timestamptz,
  consent_evidence text,
  suppressed_at timestamptz,
  dnd_status text NOT NULL DEFAULT 'unknown',
  consent_category text NOT NULL DEFAULT 'inquiry',
  timezone text
);
CREATE TABLE leads (
  id text PRIMARY KEY,
  business_id text NOT NULL REFERENCES businesses(id),
  contact_id text NOT NULL REFERENCES contacts(id),
  source text NOT NULL DEFAULT 'manual',
  campaign text NOT NULL DEFAULT 'Pilot campaign',
  project text NOT NULL,
  property_type text NOT NULL,
  budget_min numeric,
  budget_max numeric,
  budget_label text NOT NULL,
  location text NOT NULL,
  timeline text NOT NULL,
  qualification_status text NOT NULL DEFAULT 'New enquiry',
  intent_score integer NOT NULL DEFAULT 50,
  score text NOT NULL DEFAULT 'warm',
  next_action text NOT NULL DEFAULT 'Call lead',
  status text NOT NULL DEFAULT 'new',
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  urgency text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE calls (
  id text PRIMARY KEY,
  business_id text NOT NULL REFERENCES businesses(id),
  contact_id text NOT NULL REFERENCES contacts(id),
  lead_id text NOT NULL REFERENCES leads(id),
  provider text NOT NULL DEFAULT 'Retell',
  provider_call_id text,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  started_at timestamptz,
  ended_at timestamptz,
  duration_seconds integer,
  summary text NOT NULL DEFAULT 'Call queued for the approved qualification script.',
  outcome text NOT NULL DEFAULT 'Queued',
  transferred boolean NOT NULL DEFAULT false,
  booked boolean NOT NULL DEFAULT false,
  error_state text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX calls_provider_call_unique ON calls (business_id, provider, provider_call_id);
CREATE UNIQUE INDEX calls_business_idempotency_unique ON calls (business_id, idempotency_key);
CREATE TABLE appointments (
  id text PRIMARY KEY,
  business_id text NOT NULL REFERENCES businesses(id),
  contact_id text NOT NULL REFERENCES contacts(id),
  lead_id text NOT NULL REFERENCES leads(id),
  service_or_property text NOT NULL,
  start_time timestamptz NOT NULL,
  end_time timestamptz NOT NULL,
  timezone text NOT NULL,
  calendar_provider text NOT NULL DEFAULT 'Cal.com',
  external_id text NOT NULL,
  status text NOT NULL DEFAULT 'confirmed',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX appointments_calendar_external_unique ON appointments (business_id, calendar_provider, external_id);
CREATE TABLE activities (
  id text PRIMARY KEY,
  business_id text NOT NULL REFERENCES businesses(id),
  type text NOT NULL,
  title text NOT NULL,
  detail text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE usage (
  id text PRIMARY KEY,
  business_id text NOT NULL REFERENCES businesses(id),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  voice_minutes numeric NOT NULL DEFAULT '0',
  sms_count integer NOT NULL DEFAULT 0,
  booking_count integer NOT NULL DEFAULT 0,
  estimated_cost numeric NOT NULL DEFAULT '0'
);
CREATE TABLE suppressions (
  id text PRIMARY KEY,
  business_id text NOT NULL REFERENCES businesses(id),
  phone text NOT NULL,
  reason text NOT NULL,
  source text NOT NULL DEFAULT 'operator',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE workflow_jobs (
  id text PRIMARY KEY,
  business_id text NOT NULL REFERENCES businesses(id),
  type text NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  last_error text
);
CREATE UNIQUE INDEX workflow_jobs_business_idempotency_unique ON workflow_jobs (business_id, idempotency_key);
CREATE TABLE provider_events (
  id text PRIMARY KEY,
  business_id text NOT NULL REFERENCES businesses(id),
  provider text NOT NULL,
  external_event_id text NOT NULL,
  payload_hash text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  processed_at timestamptz
);
CREATE UNIQUE INDEX provider_events_provider_external_unique ON provider_events (business_id, provider, external_event_id);
CREATE TABLE memberships (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_id text NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX memberships_user_business_unique ON memberships (user_id, business_id);
CREATE INDEX memberships_business_role_idx ON memberships (business_id, role);
CREATE TABLE invitations (
  id text PRIMARY KEY,
  business_id text NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  invited_by_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL DEFAULT 'member',
  token_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invitations_business_created_idx ON invitations (business_id, created_at);
CREATE INDEX invitations_business_email_status_idx ON invitations (business_id, email, status);
CREATE INDEX invitations_business_status_expires_idx ON invitations (business_id, status, expires_at);
CREATE TABLE audit_logs (
  id text PRIMARY KEY,
  business_id text REFERENCES businesses(id) ON DELETE SET NULL,
  user_id text REFERENCES users(id) ON DELETE SET NULL,
  entity text NOT NULL,
  entity_id text,
  action text NOT NULL,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_business_created_idx ON audit_logs (business_id, created_at);
CREATE TABLE api_keys (
  id text PRIMARY KEY,
  business_id text NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  created_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  name text NOT NULL,
  key_prefix text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  scopes jsonb NOT NULL DEFAULT '["leads:intake"]'::jsonb,
  last_used_at timestamptz,
  revoked_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_keys_business_created_idx ON api_keys (business_id, created_at);
CREATE TABLE provider_credentials (
  id text PRIMARY KEY,
  business_id text NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  provider text NOT NULL,
  encrypted_config text NOT NULL,
  key_version integer NOT NULL DEFAULT 1,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX provider_credentials_business_provider_unique ON provider_credentials (business_id, provider);
CREATE TABLE agents (
  id text PRIMARY KEY,
  business_id text NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  created_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  name text NOT NULL,
  use_case text NOT NULL DEFAULT 'real_estate_qualifier',
  status text NOT NULL DEFAULT 'draft',
  language text NOT NULL DEFAULT 'en-US',
  retell_agent_id text,
  retell_llm_id text,
  published_version integer,
  voice_id text,
  voice_model text,
  voice_speed numeric DEFAULT '1.0',
  voice_temperature numeric DEFAULT '0.0',
  greeting text NOT NULL DEFAULT '',
  system_prompt text NOT NULL DEFAULT '',
  fallback_message text NOT NULL DEFAULT 'Let me connect you with a team member who can help.',
  qualification_questions jsonb NOT NULL DEFAULT '[]'::jsonb,
  escalation_rules text NOT NULL DEFAULT 'Transfer questions outside approved business information to a human.',
  tools_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  call_behavior jsonb NOT NULL DEFAULT '{}'::jsonb,
  working_days text[] NOT NULL DEFAULT ARRAY['Mon','Tue','Wed','Thu','Fri'],
  hours_start text NOT NULL DEFAULT '09:00',
  hours_end text NOT NULL DEFAULT '21:00',
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX agents_business_retell_agent_unique ON agents (business_id, retell_agent_id);
CREATE INDEX agents_business_status_idx ON agents (business_id, status);
CREATE TABLE agent_versions (
  id text PRIMARY KEY,
  business_id text NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  version_number integer NOT NULL,
  retell_version integer,
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  published_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  notes text
);
CREATE TABLE phone_numbers (
  id text PRIMARY KEY,
  business_id text NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'retell',
  e164_number text NOT NULL UNIQUE,
  nickname text,
  market text NOT NULL DEFAULT 'US',
  inbound_agent_id text REFERENCES agents(id) ON DELETE SET NULL,
  outbound_agent_id text REFERENCES agents(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active',
  retell_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX phone_numbers_business_idx ON phone_numbers (business_id);
ALTER TABLE calls ADD COLUMN agent_id text;
ALTER TABLE calls ADD COLUMN phone_number_id text;
ALTER TABLE calls ADD COLUMN direction text NOT NULL DEFAULT 'outbound';
ALTER TABLE calls ADD COLUMN caller_number text;
ALTER TABLE calls ADD COLUMN destination_number text;
ALTER TABLE calls ADD COLUMN transcript text;
ALTER TABLE calls ADD COLUMN transcript_json jsonb;
ALTER TABLE calls ADD COLUMN recording_url text;
ALTER TABLE calls ADD COLUMN disconnection_reason text;
`;

export async function createTestDb(): Promise<TestDb> {
  const client = new PGlite();
  await client.exec(DDL);
  return drizzle(client, { schema });
}

/** A fully configured pilot workspace — passes the onboarding checklist. */
export function pilotBusiness(overrides: Record<string, unknown> = {}) {
  return {
    id: "business_pilot",
    name: "Northstar Realty",
    market: "US",
    timezone: "America/New_York",
    phoneNumber: "+12125550148",
    transferNumber: "+12125550199",
    quietHours: "21:00–08:00",
    maxCallAttempts: 2,
    projectName: "Spring buyer campaign",
    servicesOrPropertyTypes: ["Condos"],
    approvedFaq: "We help buyers in Manhattan and Brooklyn.",
    qualificationQuestions: ["What area?", "What budget?"],
    escalationRules: "Transfer anything outside approved info.",
    calEventTypeId: "12345",
    retellAgentId: "agent_live",
    ...overrides,
  };
}
