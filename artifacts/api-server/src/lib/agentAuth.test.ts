import { beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import type { Request } from "express";
import { businessesTable, usersTable } from "@workspace/db";
import { createTestDb, pilotBusiness } from "../test/testDb";
import { upsertTenantProviderCredential } from "./security";
import { AgentAuthError, parseAgentToolRequest } from "./agentAuth";

const API_KEY = "test_retell_api_key";
process.env["RETELL_API_KEY"] = API_KEY;
process.env["APP_ENCRYPTION_KEY"] = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function sign(body: string, timestampMs: number, key = API_KEY): string {
  const digest = crypto.createHmac("sha256", key).update(body + String(timestampMs)).digest("hex");
  return `v=${timestampMs},d=${digest}`;
}

function makeRequest(bodyObj: unknown, signatureHeader?: string): Request {
  return {
    body: bodyObj,
    get: (header: string) => (header.toLowerCase() === "x-retell-signature" ? signatureHeader : undefined),
  } as unknown as Request;
}

describe("parseAgentToolRequest", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  const validPayload = {
    name: "book_appointment",
    call: { call_id: "call_abc", metadata: { business_id: "biz_1", lead_id: "lead_1" } },
    args: { slot_start: "2026-09-10T15:00:00Z" },
  };

  it("parses a validly signed request and extracts business/lead/call from call.metadata, not args", async () => {
    const body = JSON.stringify(validPayload);
    const now = Date.now();
    const sig = sign(body, now);
    const req = makeRequest(validPayload, sig);
    const result = await parseAgentToolRequest(req, Buffer.from(body), db as never);
    expect(result).toEqual({
      businessId: "biz_1",
      leadId: "lead_1",
      callId: "call_abc",
      args: { slot_start: "2026-09-10T15:00:00Z" },
    });
  });

  it("throws AgentAuthError(401) on an invalid signature", async () => {
    const body = JSON.stringify(validPayload);
    const req = makeRequest(validPayload, "v=123,d=deadbeef");
    await expect(parseAgentToolRequest(req, Buffer.from(body), db as never)).rejects.toThrow(AgentAuthError);
    try {
      await parseAgentToolRequest(req, Buffer.from(body), db as never);
    } catch (error) {
      expect(error).toBeInstanceOf(AgentAuthError);
      expect((error as AgentAuthError).statusCode).toBe(401);
    }
  });

  it("throws AgentAuthError(400) when metadata is missing business_id/lead_id", async () => {
    const badPayload = { call: { call_id: "call_abc", metadata: {} } };
    const body = JSON.stringify(badPayload);
    const now = Date.now();
    const sig = sign(body, now);
    const req = makeRequest(badPayload, sig);
    try {
      await parseAgentToolRequest(req, Buffer.from(body), db as never);
      expect.fail("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentAuthError);
      expect((error as AgentAuthError).statusCode).toBe(400);
    }
  });

  // The critical security property: even if a malicious or confused LLM
  // tool call includes its own business_id/lead_id inside `args`, those
  // are ignored — only call.metadata (set by LeadSprint itself, not the
  // model) is trusted.
  it("ignores business_id/lead_id if supplied inside args instead of call.metadata", async () => {
    const spoofPayload = {
      call: { call_id: "call_abc", metadata: { business_id: "biz_real", lead_id: "lead_real" } },
      args: { business_id: "biz_SPOOFED", lead_id: "lead_SPOOFED", slot_start: "x" },
    };
    const body = JSON.stringify(spoofPayload);
    const sig = sign(body, Date.now());
    const req = makeRequest(spoofPayload, sig);
    const result = await parseAgentToolRequest(req, Buffer.from(body), db as never);
    expect(result.businessId).toBe("biz_real");
    expect(result.leadId).toBe("lead_real");
    // args are passed through untouched for the route to use, but the
    // identity fields inside them were never read for auth purposes.
    expect(result.args.business_id).toBe("biz_SPOOFED");
  });

  it("verifies using the tenant's encrypted Retell webhook secret and rejects global key fallback when configured", async () => {
    await db.insert(businessesTable).values(pilotBusiness({ id: "biz_1", name: "Tenant 1" }) as never);
    await db.insert(usersTable).values({ id: "user_1", businessId: "biz_1", name: "Owner 1", email: "o1@example.com", role: "owner" });
    await upsertTenantProviderCredential(db as never, {
      businessId: "biz_1",
      userId: "user_1",
      provider: "retell",
      config: { api_key: "tenant_retell_api_key", webhook_secret: "tenant_retell_whsec" },
    });

    const body = JSON.stringify(validPayload);
    const now = Date.now();
    const globalSig = sign(body, now, API_KEY);
    await expect(
      parseAgentToolRequest(makeRequest(validPayload, globalSig), Buffer.from(body), db as never),
    ).rejects.toThrow(AgentAuthError);

    const tenantSig = sign(body, now, "tenant_retell_whsec");
    const parsed = await parseAgentToolRequest(makeRequest(validPayload, tenantSig), Buffer.from(body), db as never);
    expect(parsed.businessId).toBe("biz_1");
  });
});
