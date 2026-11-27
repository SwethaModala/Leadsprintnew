import crypto from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { callsTable, providerEventsTable } from "@workspace/db";
import { recordVoiceUsage, VOICE_COST_PER_MINUTE, type DbHandle } from "./usage";

export const BILLABLE_DISCONNECTION_REASONS = new Set([
  "user_hangup",
  "agent_hangup",
  "call_transfer",
]);

export const NON_CONNECTED_DISCONNECTION_REASONS = new Set([
  "not_connected",
  "dial_failed",
  "dial_no_answer",
  "dial_busy",
  "telephony_provider_unavailable",
  "invalid_destination",
  "concurrency_limit_reached",
  "voicemail_reached",
  "error",
  "policy_blocked",
  "invalid_phone",
  "canceled",
  "suppressed",
  "worker_timeout",
]);

export function parseValidEpochMs(val: unknown): number | null {
  if (typeof val !== "number" || !Number.isFinite(val) || !Number.isInteger(val)) {
    return null;
  }
  const MIN_EPOCH = 1704067200000; // Jan 1, 2024
  const MAX_EPOCH = 2082758400000; // Dec 31, 2035
  if (val < MIN_EPOCH || val > MAX_EPOCH) {
    return null;
  }
  return val;
}

export function parseDurationSeconds(durationMs: unknown): number | null {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) {
    return null;
  }
  return Math.floor(durationMs / 1000);
}

export function parseValidDurationMs(durationMs: unknown): number | null {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs <= 0) {
    return null;
  }
  return durationMs;
}

export interface BillingEligibilityInput {
  status: string;
  connectedAt: Date | string | null | undefined;
  durationSeconds: number | null | undefined;
  providerStatus?: string | null;
  disconnectionReason?: string | null;
}

/**
 * Evaluates whether a call is eligible for customer voice billing.
 * Deny-by-default on missing, invalid, non-connected, or voicemail reasons.
 */
export function isEligibleForVoiceBilling(input: BillingEligibilityInput): boolean {
  if (input.status !== "completed") {
    return false;
  }

  if (!input.connectedAt) {
    return false;
  }
  const connectedMs = new Date(input.connectedAt).getTime();
  if (Number.isNaN(connectedMs) || connectedMs <= 0) {
    return false;
  }

  if (
    typeof input.durationSeconds !== "number" ||
    !Number.isInteger(input.durationSeconds) ||
    input.durationSeconds <= 0
  ) {
    return false;
  }

  if (input.providerStatus === "not_connected" || input.providerStatus === "error") {
    return false;
  }

  if (!input.disconnectionReason || !BILLABLE_DISCONNECTION_REASONS.has(input.disconnectionReason)) {
    return false;
  }

  return true;
}

export interface ReconcileAndBillInput {
  callId: string;
  businessId: string;
  providerStatus?: string | null;
  startTimestampMs?: number | null;
  endTimestampMs?: number | null;
  durationMs?: number | null;
  disconnectionReason?: string | null;
  transcript?: string | null;
  analysis?: string | null;
  sourceEvent: string;
}

export interface ReconcileAndBillResult {
  billed: boolean;
  status: string;
  call: typeof callsTable.$inferSelect | null;
}

/**
 * Shared reconciliation and billing helper executed under an existing transaction handle.
 * Guarantees monotonic terminal status, verified connection evidence, and exactly-once billing.
 */
export async function reconcileCallAndBillUnderLock(
  tx: DbHandle,
  input: ReconcileAndBillInput,
): Promise<ReconcileAndBillResult> {
  const [call] = await tx
    .select()
    .from(callsTable)
    .where(and(eq(callsTable.id, input.callId), eq(callsTable.businessId, input.businessId)))
    .for("update");

  if (!call) {
    return { billed: false, status: "not_found", call: null };
  }

  const wasTerminal = call.status === "completed" || call.status === "failed";
  let nextStatus = call.status;

  if (!wasTerminal) {
    if (input.providerStatus === "ended") {
      const isFailedReason =
        input.disconnectionReason &&
        NON_CONNECTED_DISCONNECTION_REASONS.has(input.disconnectionReason);
      nextStatus = isFailedReason ? "failed" : "completed";
    } else if (input.providerStatus === "not_connected" || input.providerStatus === "error") {
      nextStatus = "failed";
    }
  }

  // Duration and disconnection reason resolution: preserve previously stored valid values if incoming is null/undefined
  const incomingDurationSec = parseDurationSeconds(input.durationMs);
  const nextDuration = incomingDurationSec ?? call.durationSeconds;
  const nextDisconnection = input.disconnectionReason ?? call.disconnectionReason;

  // Connection timestamp resolution
  // Strict priority:
  // 1. Valid provider start_timestamp (epoch milliseconds).
  // 2. If unavailable, valid provider end_timestamp minus original provider duration_ms.
  // 3. If neither is available, keep connectedAt null.
  //
  // Important rules:
  // - Validate timestamps and duration before calculating.
  // - Use the original provider duration in milliseconds (durationMs) for calculation, not rounded durationSeconds.
  // - Never use calls.startedAt or server Date.now() as connection evidence.
  // - Preserve an existing valid connectedAt.
  // - Keep the existing completed-status, positive-duration and approved-disconnection-reason billing gates.
  const incomingStartEpoch = parseValidEpochMs(input.startTimestampMs);
  const incomingEndEpoch = parseValidEpochMs(input.endTimestampMs);
  const incomingDurationMs = parseValidDurationMs(input.durationMs);

  const isApprovedBillableDisconnection =
    Boolean(nextDisconnection && BILLABLE_DISCONNECTION_REASONS.has(nextDisconnection));
  const isCompletedWithValidDuration =
    nextStatus === "completed" &&
    typeof nextDuration === "number" &&
    Number.isInteger(nextDuration) &&
    nextDuration > 0;

  let nextConnectedAt = call.connectedAt ?? null;
  if (isCompletedWithValidDuration && isApprovedBillableDisconnection) {
    if (!nextConnectedAt) {
      if (incomingStartEpoch !== null) {
        nextConnectedAt = new Date(incomingStartEpoch);
      } else if (incomingEndEpoch !== null && incomingDurationMs !== null) {
        const derivedStartMs = Math.round(incomingEndEpoch - incomingDurationMs);
        const validDerived = parseValidEpochMs(derivedStartMs);
        nextConnectedAt = validDerived !== null ? new Date(validDerived) : null;
      } else {
        nextConnectedAt = null;
      }
    }
  }

  const currentMetadata = (call.metadata ?? {}) as Record<string, unknown>;
  const isTerminalNow = nextStatus === "completed" || nextStatus === "failed";

  const [updatedCall] = await tx
    .update(callsTable)
    .set({
      status: nextStatus,
      durationSeconds: nextDuration,
      connectedAt: nextConnectedAt,
      endedAt: isTerminalNow ? (call.endedAt ?? new Date()) : null,
      disconnectionReason: nextDisconnection,
      transcript: input.transcript ?? call.transcript,
      summary: input.analysis ?? call.summary,
      metadata: {
        ...currentMetadata,
        ...(isTerminalNow ? { operator_stop_pending: false, operator_stop_ambiguous: false } : {}),
      },
    })
    .where(eq(callsTable.id, call.id))
    .returning();

  const eligible = isEligibleForVoiceBilling({
    status: nextStatus,
    connectedAt: nextConnectedAt,
    durationSeconds: nextDuration,
    providerStatus: input.providerStatus,
    disconnectionReason: nextDisconnection,
  });

  if (!eligible) {
    return { billed: false, status: nextStatus, call: updatedCall ?? call };
  }

  const billingKey = `usage_billed_${call.id}`;
  const payloadHash = crypto.createHash("sha256").update(billingKey).digest("hex");

  const [claim] = await tx
    .insert(providerEventsTable)
    .values({
      id: `event_${crypto.randomUUID().slice(0, 12)}`,
      businessId: call.businessId,
      provider: "Retell",
      externalEventId: billingKey,
      payloadHash,
      eventType: "usage_billed",
      payload: {
        call_id: call.id,
        duration_seconds: nextDuration,
        billed_at: new Date().toISOString(),
        source: input.sourceEvent,
      },
      processedAt: new Date(),
    })
    .onConflictDoNothing({
      target: [
        providerEventsTable.businessId,
        providerEventsTable.provider,
        providerEventsTable.externalEventId,
      ],
    })
    .returning({ id: providerEventsTable.id });

  if (claim) {
    await recordVoiceUsage(tx, call.businessId, nextDuration! / 60, VOICE_COST_PER_MINUTE);
    return { billed: true, status: nextStatus, call: updatedCall ?? call };
  }

  return { billed: false, status: nextStatus, call: updatedCall ?? call };
}
