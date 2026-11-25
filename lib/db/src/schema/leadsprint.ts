import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const businessesTable = pgTable("businesses", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").unique(),
  market: text("market").notNull().default("US"),
  timezone: text("timezone").notNull().default("America/New_York"),
  phoneNumber: text("phone_number").notNull(),
  transferNumber: text("transfer_number").notNull(),
  recordingDisclosure: boolean("recording_disclosure").notNull().default(true),
  aiDisclosure: boolean("ai_disclosure").notNull().default(true),
  quietHours: text("quiet_hours").notNull().default("21:00–08:00"),
  maxCallAttempts: integer("max_call_attempts").notNull().default(2),
  suppressionEnabled: boolean("suppression_enabled").notNull().default(true),
  projectName: text("project_name").notNull(),
  servicesOrPropertyTypes: text("services_or_property_types").array().notNull().default([]),
  approvedFaq: text("approved_faq").notNull().default(""),
  qualificationQuestions: text("qualification_questions").array().notNull().default([]),
  escalationRules: text("escalation_rules").notNull().default("Transfer questions outside approved business information to a human."),
  calEventTypeId: text("cal_event_type_id"),
  retellAgentId: text("retell_agent_id"),
  // Which industry profile this workspace runs (see the api-server's
  // lib/verticals). Real estate is the original behaviour and the default.
  vertical: text("vertical").notNull().default("real_estate"),
  // Where instant emergency-lead emails go (home services). Optional.
  notifyEmail: text("notify_email"),
  // ZIP entries the business serves: exact 5-digit ZIPs or 3-4 digit
  // prefixes. Empty means "no service-area check".
  serviceAreaZips: jsonb("service_area_zips").$type<string[]>().notNull().default([]),
  // Exact wording the voice agent may use about cost (e.g. a diagnostic fee).
  // When unset the agent says a technician will confirm the cost.
  pricingPolicy: text("pricing_policy"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const usersTable = pgTable("users", {
  id: text("id").primaryKey(),
  businessId: text("business_id").notNull().references(() => businessesTable.id),
  name: text("name").notNull(),
  email: text("email").notNull(),
  role: text("role").notNull().default("owner"),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
});

export const contactsTable = pgTable("contacts", {
  id: text("id").primaryKey(),
  businessId: text("business_id").notNull().references(() => businessesTable.id),
  name: text("name").notNull(),
  phone: text("phone").notNull(),
  email: text("email"),
  preferredLanguage: text("preferred_language").notNull().default("en"),
  // Launch gate: a contact is NOT callable until someone records why it is
  // lawful to call them. The old default ("valid") meant any row created by
  // intake or CSV import became callable with no evidence at all, so the
  // default is now "unknown" and the policy gate blocks it. Valid values:
  // unknown | valid | revoked.
  consentStatus: text("consent_status").notNull().default("unknown"),
  // Evidence for the consent decision: where it came from (e.g.
  // "web_form:listing-enquiry", "csv:2026-09-16 seller list", "verbal") and
  // when it was captured. Both are required before consent may be "valid".
  consentSource: text("consent_source"),
  consentAt: timestamp("consent_at", { withTimezone: true }),
  // The consent wording the person actually saw (for example a Meta lead
  // form's disclaimer), kept as evidence alongside the source and time.
  consentEvidence: text("consent_evidence"),
  suppressedAt: timestamp("suppressed_at", { withTimezone: true }),
  dndStatus: text("dnd_status").notNull().default("unknown"),
  consentCategory: text("consent_category").notNull().default("inquiry"),
  // Called-party IANA timezone, derived from the phone number's area code
  // at intake (see lib/areaCodeTimezones.ts). NULL means "we couldn't
  // determine it" — the policy gate blocks rather than guessing, since
  // quiet-hours law is defined by the recipient's local time, not the
  // business's.
  timezone: text("timezone"),
});

export const leadsTable = pgTable("leads", {
  id: text("id").primaryKey(),
  businessId: text("business_id").notNull().references(() => businessesTable.id),
  contactId: text("contact_id").notNull().references(() => contactsTable.id),
  source: text("source").notNull().default("manual"),
  campaign: text("campaign").notNull().default("Pilot campaign"),
  project: text("project").notNull(),
  propertyType: text("property_type").notNull(),
  budgetMin: numeric("budget_min"),
  budgetMax: numeric("budget_max"),
  budgetLabel: text("budget_label").notNull(),
  location: text("location").notNull(),
  timeline: text("timeline").notNull(),
  qualificationStatus: text("qualification_status").notNull().default("New enquiry"),
  intentScore: integer("intent_score").notNull().default(50),
  score: text("score").notNull().default("warm"),
  nextAction: text("next_action").notNull().default("Call lead"),
  status: text("status").notNull().default("new"),
  // Industry-specific answers (service type, problem, ZIP...). The keys come
  // from the workspace's vertical profile; real estate keeps using the legacy
  // columns above and leaves this empty.
  details: jsonb("details").$type<Record<string, string | number | boolean>>().notNull().default({}),
  // Kept as a column (not inside `details`) so it can be filtered and sorted.
  urgency: text("urgency"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const callsTable = pgTable("calls", {
  id: text("id").primaryKey(),
  businessId: text("business_id").notNull().references(() => businessesTable.id),
  contactId: text("contact_id").notNull().references(() => contactsTable.id),
  leadId: text("lead_id").notNull().references(() => leadsTable.id),
  provider: text("provider").notNull().default("Retell"),
  providerCallId: text("provider_call_id"),
  idempotencyKey: text("idempotency_key").notNull(),
  status: text("status").notNull().default("queued"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  durationSeconds: integer("duration_seconds"),
  summary: text("summary").notNull().default("Call queued for the approved qualification script."),
  outcome: text("outcome").notNull().default("Queued"),
  transferred: boolean("transferred").notNull().default(false),
  booked: boolean("booked").notNull().default(false),
  errorState: text("error_state"),
  // Phase 3 additions — all nullable for backward compat with existing rows
  agentId: text("agent_id"),                                   // FK set post-insert; references agentsTable
  phoneNumberId: text("phone_number_id"),                      // FK set post-insert; references phoneNumbersTable
  direction: text("direction").notNull().default("outbound"),  // outbound | inbound
  callerNumber: text("caller_number"),                         // E.164 of the caller (inbound)
  destinationNumber: text("destination_number"),               // E.164 dialled
  transcript: text("transcript"),                              // Plain-text transcript from Retell
  transcriptJson: jsonb("transcript_json")                     // Structured [{role,content,...}]
    .$type<Array<Record<string, unknown>>>(),
  recordingUrl: text("recording_url"),
  disconnectionReason: text("disconnection_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  // Provider call ids are only unique within a tenant: two workspaces may
  // legitimately hold the same provider id (separate Twilio subaccounts,
  // stub/dev ids), and a global constraint would make the second business's
  // insert fail — while a global index is exactly what a cross-tenant
  // webhook lookup would scan. Always scope by business_id.
  providerCallUnique: uniqueIndex("calls_provider_call_unique").on(table.businessId, table.provider, table.providerCallId),
  idempotencyUnique: uniqueIndex("calls_business_idempotency_unique").on(table.businessId, table.idempotencyKey),
}));

export const appointmentsTable = pgTable("appointments", {
  id: text("id").primaryKey(),
  businessId: text("business_id").notNull().references(() => businessesTable.id),
  contactId: text("contact_id").notNull().references(() => contactsTable.id),
  leadId: text("lead_id").notNull().references(() => leadsTable.id),
  serviceOrProperty: text("service_or_property").notNull(),
  startTime: timestamp("start_time", { withTimezone: true }).notNull(),
  endTime: timestamp("end_time", { withTimezone: true }).notNull(),
  timezone: text("timezone").notNull(),
  calendarProvider: text("calendar_provider").notNull().default("Cal.com"),
  externalId: text("external_id").notNull(),
  status: text("status").notNull().default("confirmed"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  calendarExternalUnique: uniqueIndex("appointments_calendar_external_unique").on(table.businessId, table.calendarProvider, table.externalId),
}));

export const activitiesTable = pgTable("activities", {
  id: text("id").primaryKey(),
  businessId: text("business_id").notNull().references(() => businessesTable.id),
  type: text("type").notNull(),
  title: text("title").notNull(),
  detail: text("detail").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const usageTable = pgTable("usage", {
  id: text("id").primaryKey(),
  businessId: text("business_id").notNull().references(() => businessesTable.id),
  periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
  periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
  voiceMinutes: numeric("voice_minutes").notNull().default("0"),
  smsCount: integer("sms_count").notNull().default(0),
  bookingCount: integer("booking_count").notNull().default(0),
  estimatedCost: numeric("estimated_cost").notNull().default("0"),
});

export const suppressionsTable = pgTable("suppressions", {
  id: text("id").primaryKey(),
  businessId: text("business_id").notNull().references(() => businessesTable.id),
  phone: text("phone").notNull(),
  reason: text("reason").notNull(),
  source: text("source").notNull().default("operator"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const workflowJobsTable = pgTable("workflow_jobs", {
  id: text("id").primaryKey(),
  businessId: text("business_id").notNull().references(() => businessesTable.id),
  type: text("type").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  status: text("status").notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  lastError: text("last_error"),
}, (table) => ({
  jobIdempotencyUnique: uniqueIndex("workflow_jobs_business_idempotency_unique").on(table.businessId, table.idempotencyKey),
}));

export const providerEventsTable = pgTable("provider_events", {
  id: text("id").primaryKey(),
  businessId: text("business_id").notNull().references(() => businessesTable.id),
  provider: text("provider").notNull(),
  externalEventId: text("external_event_id").notNull(),
  payloadHash: text("payload_hash").notNull(),
  eventType: text("event_type").notNull(),
  payload: jsonb("payload").notNull().default({}),
  processedAt: timestamp("processed_at", { withTimezone: true }),
}, (table) => ({
  providerEventUnique: uniqueIndex("provider_events_provider_external_unique").on(table.businessId, table.provider, table.externalEventId),
}));

export const membershipsTable = pgTable("memberships", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  businessId: text("business_id").notNull().references(() => businessesTable.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("member"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => ({
  userBusinessUnique: uniqueIndex("memberships_user_business_unique").on(table.userId, table.businessId),
  businessRoleIdx: index("memberships_business_role_idx").on(table.businessId, table.role),
}));

export const invitationsTable = pgTable("invitations", {
  id: text("id").primaryKey(),
  businessId: text("business_id").notNull().references(() => businessesTable.id, { onDelete: "cascade" }),
  invitedByUserId: text("invited_by_user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: text("role").notNull().default("member"),
  tokenHash: text("token_hash").notNull().unique(),
  status: text("status").notNull().default("pending"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => ({
  businessCreatedIdx: index("invitations_business_created_idx").on(table.businessId, table.createdAt),
  businessEmailStatusIdx: index("invitations_business_email_status_idx").on(table.businessId, table.email, table.status),
  businessStatusExpiresIdx: index("invitations_business_status_expires_idx").on(table.businessId, table.status, table.expiresAt),
}));

export const auditLogsTable = pgTable("audit_logs", {
  id: text("id").primaryKey(),
  businessId: text("business_id").references(() => businessesTable.id, { onDelete: "set null" }),
  userId: text("user_id").references(() => usersTable.id, { onDelete: "set null" }),
  entity: text("entity").notNull(),
  entityId: text("entity_id"),
  action: text("action").notNull(),
  details: jsonb("details").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  businessCreatedIdx: index("audit_logs_business_created_idx").on(table.businessId, table.createdAt),
}));

export const apiKeysTable = pgTable("api_keys", {
  id: text("id").primaryKey(),
  businessId: text("business_id").notNull().references(() => businessesTable.id, { onDelete: "cascade" }),
  createdByUserId: text("created_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  keyPrefix: text("key_prefix").notNull(),
  keyHash: text("key_hash").notNull().unique(),
  scopes: jsonb("scopes").$type<string[]>().notNull().default(["leads:intake"]),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  businessCreatedIdx: index("api_keys_business_created_idx").on(table.businessId, table.createdAt),
}));

export const providerCredentialsTable = pgTable("provider_credentials", {
  id: text("id").primaryKey(),
  businessId: text("business_id").notNull().references(() => businessesTable.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  encryptedConfig: text("encrypted_config").notNull(),
  keyVersion: integer("key_version").notNull().default(1),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => ({
  businessProviderUnique: uniqueIndex("provider_credentials_business_provider_unique").on(table.businessId, table.provider),
}));

// ---------------------------------------------------------------------------
// Phase 3: AI Agents, Agent Versions, Phone Numbers
// ---------------------------------------------------------------------------

/**
 * Per-workspace AI agents, each linked to a Retell Agent + LLM pair.
 * A workspace can have multiple agents (e.g. one for real-estate, one for
 * home-services); only one is active on a given phone number at a time.
 */
export const agentsTable = pgTable("agents", {
  id: text("id").primaryKey(),
  businessId: text("business_id").notNull().references(() => businessesTable.id, { onDelete: "cascade" }),
  createdByUserId: text("created_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  useCase: text("use_case").notNull().default("real_estate_qualifier"),
  status: text("status").notNull().default("draft"),          // draft | active | paused
  language: text("language").notNull().default("en-US"),
  retellAgentId: text("retell_agent_id"),                     // Retell Agent ID after create/link
  retellLlmId: text("retell_llm_id"),                         // Retell LLM/response-engine ID
  publishedVersion: integer("published_version"),
  voiceId: text("voice_id"),
  voiceModel: text("voice_model"),
  voiceSpeed: numeric("voice_speed").default("1.0"),
  voiceTemperature: numeric("voice_temperature").default("0.0"),
  greeting: text("greeting").notNull().default(""),
  systemPrompt: text("system_prompt").notNull().default(""),
  fallbackMessage: text("fallback_message").notNull().default(
    "Let me connect you with a team member who can help.",
  ),
  qualificationQuestions: jsonb("qualification_questions")
    .$type<string[]>()
    .notNull()
    .default([]),
  escalationRules: text("escalation_rules").notNull().default(
    "Transfer questions outside approved business information to a human.",
  ),
  toolsConfig: jsonb("tools_config").$type<Record<string, unknown>>().notNull().default({}),
  callBehavior: jsonb("call_behavior").$type<Record<string, unknown>>().notNull().default({}),
  workingDays: text("working_days").array().notNull().default(["Mon", "Tue", "Wed", "Thu", "Fri"]),
  hoursStart: text("hours_start").notNull().default("09:00"),
  hoursEnd: text("hours_end").notNull().default("21:00"),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => ({
  // Prevent two workspaces from linking to the same Retell agent ID —
  // an inbound call from Retell carries only an agent_id and would be
  // ambiguous (and exploitable) if two tenants shared one.
  retellAgentUnique: uniqueIndex("agents_business_retell_agent_unique").on(
    table.businessId,
    table.retellAgentId,
  ),
  businessStatusIdx: index("agents_business_status_idx").on(table.businessId, table.status),
}));

/**
 * Immutable snapshots of agent config at each publish event, for rollback
 * and audit.
 */
export const agentVersionsTable = pgTable("agent_versions", {
  id: text("id").primaryKey(),
  businessId: text("business_id").notNull().references(() => businessesTable.id, { onDelete: "cascade" }),
  agentId: text("agent_id").notNull().references(() => agentsTable.id, { onDelete: "cascade" }),
  versionNumber: integer("version_number").notNull(),
  retellVersion: integer("retell_version"),
  snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull().default({}),
  publishedByUserId: text("published_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
  notes: text("notes"),
});

/**
 * Phone numbers provisioned in Retell or Twilio, linked to inbound/outbound
 * agents per workspace.
 */
export const phoneNumbersTable = pgTable("phone_numbers", {
  id: text("id").primaryKey(),
  businessId: text("business_id").notNull().references(() => businessesTable.id, { onDelete: "cascade" }),
  provider: text("provider").notNull().default("retell"),    // retell | twilio
  e164Number: text("e164_number").notNull().unique(),
  nickname: text("nickname"),
  market: text("market").notNull().default("US"),            // US | IN
  inboundAgentId: text("inbound_agent_id").references(() => agentsTable.id, { onDelete: "set null" }),
  outboundAgentId: text("outbound_agent_id").references(() => agentsTable.id, { onDelete: "set null" }),
  status: text("status").notNull().default("active"),        // active | inactive
  retellSyncedAt: timestamp("retell_synced_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => ({
  businessPhoneIdx: index("phone_numbers_business_idx").on(table.businessId),
}));

export const insertBusinessSchema = createInsertSchema(businessesTable);
export const insertUserSchema = createInsertSchema(usersTable);
export const insertContactSchema = createInsertSchema(contactsTable);
export const insertLeadSchema = createInsertSchema(leadsTable);
export const insertCallSchema = createInsertSchema(callsTable);
export const insertAppointmentSchema = createInsertSchema(appointmentsTable);
export const insertActivitySchema = createInsertSchema(activitiesTable);
export const insertUsageSchema = createInsertSchema(usageTable);
export const insertSuppressionSchema = createInsertSchema(suppressionsTable);
export const insertWorkflowJobSchema = createInsertSchema(workflowJobsTable);
export const insertProviderEventSchema = createInsertSchema(providerEventsTable);
export const insertMembershipSchema = createInsertSchema(membershipsTable);
export const insertInvitationSchema = createInsertSchema(invitationsTable);
export const insertAuditLogSchema = createInsertSchema(auditLogsTable);
export const insertApiKeySchema = createInsertSchema(apiKeysTable);
export const insertProviderCredentialSchema = createInsertSchema(providerCredentialsTable);
export const insertAgentSchema = createInsertSchema(agentsTable);
export const insertAgentVersionSchema = createInsertSchema(agentVersionsTable);
export const insertPhoneNumberSchema = createInsertSchema(phoneNumbersTable);

export type Business = z.infer<typeof insertBusinessSchema>;
export type User = z.infer<typeof insertUserSchema>;
export type Contact = z.infer<typeof insertContactSchema>;
export type Lead = z.infer<typeof insertLeadSchema>;
export type Call = z.infer<typeof insertCallSchema>;
export type Appointment = z.infer<typeof insertAppointmentSchema>;
export type Membership = z.infer<typeof insertMembershipSchema>;
export type Invitation = z.infer<typeof insertInvitationSchema>;
export type AuditLog = z.infer<typeof insertAuditLogSchema>;
export type ApiKey = z.infer<typeof insertApiKeySchema>;
export type ProviderCredential = z.infer<typeof insertProviderCredentialSchema>;
export type Agent = z.infer<typeof insertAgentSchema>;
export type AgentVersion = z.infer<typeof insertAgentVersionSchema>;
export type PhoneNumber = z.infer<typeof insertPhoneNumberSchema>;