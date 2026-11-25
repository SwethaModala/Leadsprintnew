import type { Request } from "express";
import { db as defaultDb } from "@workspace/db";
import { verifyRetellSignature, extractRetellCall, providerConfig, type RetellCredentialOverride } from "./providers";
import { loadTenantProviderSecrets } from "./security";

export class AgentAuthError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message);
  }
}

export interface AgentToolRequest {
  businessId: string;
  leadId: string;
  callId: string;
  args: Record<string, unknown>;
}

/**
 * Verifies and parses an incoming Retell agent-tool ("custom function")
 * request. Uses tenant-specific encrypted Retell credentials when present,
 * falling back to deployment env only if no tenant credential is stored,
 * and always fails closed (401) on missing/invalid signature or stale timestamp.
 */
export async function parseAgentToolRequest(
  req: Request,
  rawBody: Buffer,
  database: typeof defaultDb = defaultDb,
): Promise<AgentToolRequest> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const call = extractRetellCall(body);
  const metadata = (call.metadata && typeof call.metadata === "object" ? call.metadata : {}) as Record<string, unknown>;
  const businessId = typeof metadata.business_id === "string" ? metadata.business_id : "";

  let tenantRetell: RetellCredentialOverride | null = null;
  if (businessId) {
    try {
      tenantRetell = (await loadTenantProviderSecrets(database, businessId, "retell")) as RetellCredentialOverride | null;
    } catch {
      throw new AgentAuthError("Invalid Retell signature", 401);
    }
  }

  const baseRetell = providerConfig().retell;
  const apiKey =
    tenantRetell !== null
      ? tenantRetell.webhook_secret ?? tenantRetell.api_key
      : baseRetell.webhookSecret ?? baseRetell.apiKey;
  if (!verifyRetellSignature(rawBody, req.get("x-retell-signature"), apiKey)) {
    throw new AgentAuthError("Invalid Retell signature", 401);
  }

  const leadId = typeof metadata.lead_id === "string" ? metadata.lead_id : "";
  const callId = typeof call.call_id === "string" ? call.call_id : "";
  if (!businessId || !leadId) {
    throw new AgentAuthError("call.metadata.business_id and lead_id are required", 400);
  }
  const args = (body.args && typeof body.args === "object" ? body.args : {}) as Record<string, unknown>;
  return { businessId, leadId, callId, args };
}
