/**
 * Phase 3 — Agent Management & Phone Number routes.
 *
 * All routes are tenant-scoped (req.leadSprintBusinessId) and RBAC-gated.
 * Retell calls go through retellAgentService; per-tenant encrypted
 * credentials are loaded via loadTenantProviderSecrets.
 */

import crypto from "node:crypto";
import { Router } from "express";
import { eq, and, desc, sql } from "drizzle-orm";
import {
  agentsTable,
  agentVersionsTable,
  businessesTable,
  phoneNumbersTable,
  db as defaultDb,
} from "@workspace/db";
import { requireRole } from "../middlewares/rbac";
import { loadTenantProviderSecrets } from "../lib/security";
import {
  listRetellAgents,
  createRetellAgentPair,
  updateRetellAgentPair,
  deleteRetellAgent,
  publishRetellAgent,
  listRetellVoices,
  listRetellPhoneNumbers,
  updateRetellPhoneNumberBinding,
  createRetellWebCall,
} from "../lib/retellAgentService";
import {
  providerConfig,
  ProviderNotConfiguredError,
  ProviderRequestError,
} from "../lib/providers";
import { EncryptionNotConfiguredError } from "../lib/crypto";

// ---------------------------------------------------------------------------
// Swappable DB (testability)
// ---------------------------------------------------------------------------

export type Database = typeof defaultDb;

let db: Database = defaultDb;

export function __setAgentsDb(d: Database) {
  db = d;
}
export function __resetAgentsDb() {
  db = defaultDb;
}

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 12)}`;
}

// ---------------------------------------------------------------------------
// Helper: load per-tenant Retell API key
// ---------------------------------------------------------------------------

export async function getTenantRetellKey(businessId: string): Promise<string | undefined> {
  try {
    const secrets = await loadTenantProviderSecrets(db, businessId, "retell");
    if (secrets !== null) {
      // When tenant has configured credentials, use only tenant key; never fall back to global
      return (secrets as Record<string, string | undefined>).api_key ?? undefined;
    }
  } catch (err) {
    if (err instanceof EncryptionNotConfiguredError) {
      // In unencrypted / pilot environments without APP_ENCRYPTION_KEY, allow global fallback
      return providerConfig().retell.apiKey;
    }
    // If decryption or DB lookup failed for a tenant with stored credentials, fail closed. Never leak global key.
    return undefined;
  }
  // Global env key fallback is only for single-tenant / pilot workspaces without configured credentials
  return providerConfig().retell.apiKey;
}

function formatSafeRetellErrorMessage(err: ProviderRequestError): string {
  const msg = err.message || "";
  if (
    msg.includes("401") ||
    msg.includes("403") ||
    /unauthorized|forbidden|invalid.*key|authentication/i.test(msg)
  ) {
    return "Failed to authenticate with Retell. Verify your Retell API key is valid and active.";
  }
  if (msg.includes("429") || /rate limit/i.test(msg)) {
    return "Retell API rate limit exceeded. Please try again later.";
  }
  if (/fetch failed|econnrefused|enotfound|timeout|network/i.test(msg)) {
    return "Failed to connect to Retell API. Please check network connectivity and try again.";
  }
  return "Retell API request failed. Please check your Retell configuration and try again.";
}

async function verifyRemoteRetellAgentExists(
  businessId: string,
  retellAgentId: string,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const apiKey = await getTenantRetellKey(businessId);
  if (!apiKey) {
    return {
      ok: false,
      status: 503,
      error: "Retell is not configured for this workspace",
    };
  }

  try {
    const remoteAgents = await listRetellAgents(apiKey);
    const exists = remoteAgents.some((a) => a.retell_agent_id === retellAgentId);
    if (!exists) {
      return {
        ok: false,
        status: 400,
        error: `Retell agent "${retellAgentId}" was not found in the configured Retell account.`,
      };
    }
    return { ok: true };
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) {
      return {
        ok: false,
        status: 503,
        error: "Retell is not configured for this workspace",
      };
    }
    return {
      ok: false,
      status: 502,
      error:
        err instanceof ProviderRequestError
          ? formatSafeRetellErrorMessage(err)
          : err instanceof Error
            ? err.message
            : "Failed to verify Retell agent with provider.",
    };
  }
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

function agentToDetail(row: typeof agentsTable.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    use_case: row.useCase,
    status: row.status,
    voice_id: row.voiceId,
    language: row.language,
    system_prompt: row.systemPrompt,
    greeting_message: row.greeting,
    fallback_message: row.fallbackMessage,
    temperature: row.voiceTemperature ? parseFloat(row.voiceTemperature) : null,
    retell_agent_id: row.retellAgentId,
    retell_llm_id: row.retellLlmId,
    calls_today: 0,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt?.toISOString() ?? null,
  };
}

function agentToSummary(row: typeof agentsTable.$inferSelect, callsToday = 0) {
  return {
    id: row.id,
    name: row.name,
    use_case: row.useCase,
    status: row.status,
    voice_id: row.voiceId,
    language: row.language,
    retell_agent_id: row.retellAgentId,
    calls_today: callsToday,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt?.toISOString() ?? null,
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const router = Router();

// ------ GET /agents -------------------------------------------------------
router.get("/agents", requireRole("member", "manager", "admin", "owner"), async (req, res, next) => {
  try {
    const rows = await db
      .select()
      .from(agentsTable)
      .where(eq(agentsTable.businessId, req.leadSprintBusinessId!))
      .orderBy(desc(agentsTable.createdAt));

    res.json({ agents: rows.map((r) => agentToSummary(r)) });
  } catch (err) {
    next(err);
  }
});

// ------ POST /agents -------------------------------------------------------
router.post("/agents", requireRole("admin", "owner"), async (req, res, next) => {
  try {
    const {
      name,
      use_case,
      system_prompt,
      greeting_message,
      fallback_message,
      voice_id,
      language,
      temperature,
      create_retell,
      retell_agent_id,
      retell_llm_id,
      status,
    } = req.body as {
      name: string;
      use_case: string;
      system_prompt?: string;
      greeting_message?: string;
      fallback_message?: string;
      voice_id?: string;
      language?: string;
      temperature?: number;
      create_retell?: boolean;
      retell_agent_id?: string;
      retell_llm_id?: string;
      status?: "draft" | "active" | "paused";
    };

    if (!name?.trim() || !use_case) {
      res.status(400).json({ error: "name and use_case are required" });
      return;
    }

    let retellAgentId: string | null = null;
    let retellLlmId: string | null = null;

    if (create_retell) {
      const apiKey = await getTenantRetellKey(req.leadSprintBusinessId!);
      const pair = await createRetellAgentPair({
        agentName: name,
        systemPrompt: system_prompt ?? "",
        greeting: greeting_message ?? "",
        fallbackMessage: fallback_message,
        voiceId: voice_id,
        language,
        temperature,
        apiKey,
      });
      retellAgentId = pair.retellAgentId;
      retellLlmId = pair.retellLlmId;
    } else if (retell_agent_id) {
      const trimmedId = String(retell_agent_id).trim();
      const verification = await verifyRemoteRetellAgentExists(req.leadSprintBusinessId!, trimmedId);
      if (!verification.ok) {
        res.status(verification.status).json({ error: verification.error });
        return;
      }
      retellAgentId = trimmedId;
      retellLlmId = retell_llm_id ? String(retell_llm_id).trim() : null;
    }

    const agentStatus = status && ["draft", "active", "paused"].includes(status) ? status : "draft";

    const agentId = id("agt");
    const [row] = await db
      .insert(agentsTable)
      .values({
        id: agentId,
        businessId: req.leadSprintBusinessId!,
        name: name.trim(),
        useCase: use_case,
        status: agentStatus,
        systemPrompt: system_prompt ?? "",
        greeting: greeting_message ?? "",
        fallbackMessage: fallback_message ?? "Let me connect you with a team member who can help.",
        voiceId: voice_id ?? null,
        language: language ?? "en-US",
        voiceTemperature: temperature !== undefined ? String(temperature) : "0.0",
        retellAgentId,
        retellLlmId,
        createdByUserId: req.leadSprintUserId ?? null,
      })
      .returning();

    if (retellAgentId) {
      await db
        .update(businessesTable)
        .set({
          retellAgentId,
          updatedAt: new Date(),
        })
        .where(eq(businessesTable.id, req.leadSprintBusinessId!));
    }

    res.status(201).json({ agent: agentToDetail(row!) });
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) {
      res.status(503).json({ error: "Retell is not configured for this workspace" });
      return;
    }
    if (err instanceof ProviderRequestError) {
      res.status(502).json({ error: err.message });
      return;
    }
    next(err);
  }
});

// ------ GET /agents/retell/remote ------------------------------------------
router.get("/agents/retell/remote", requireRole("admin", "owner"), async (req, res, next) => {
  try {
    const apiKey = await getTenantRetellKey(req.leadSprintBusinessId!);
    if (!apiKey) {
      res.status(503).json({ error: "Retell is not configured for this workspace" });
      return;
    }
    const agents = await listRetellAgents(apiKey);
    res.json({ agents });
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) {
      res.status(503).json({ error: "Retell is not configured for this workspace" });
      return;
    }
    if (err instanceof ProviderRequestError) {
      req.log?.warn?.({ err: err.message }, "Retell remote discovery provider failure");
      res.status(502).json({ error: formatSafeRetellErrorMessage(err) });
      return;
    }
    next(err);
  }
});

// ------ GET /agents/retell/voices ------------------------------------------
router.get("/agents/retell/voices", async (req, res, next) => {
  try {
    const apiKey = await getTenantRetellKey(req.leadSprintBusinessId!);
    const voices = await listRetellVoices(apiKey);
    res.json({ voices });
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) {
      res.status(503).json({ error: "Retell is not configured for this workspace" });
      return;
    }
    next(err);
  }
});

// ------ GET /agents/:agentId -----------------------------------------------
router.get("/agents/:agentId", requireRole("member", "manager", "admin", "owner"), async (req, res, next) => {
  try {
    const agentId = String(req.params.agentId);
    const [row] = await db
      .select()
      .from(agentsTable)
      .where(
        and(
          eq(agentsTable.id, agentId),
          eq(agentsTable.businessId, req.leadSprintBusinessId!),
        ),
      );

    if (!row) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    res.json({ agent: agentToDetail(row) });
  } catch (err) {
    next(err);
  }
});

// ------ PATCH /agents/:agentId ---------------------------------------------
router.patch("/agents/:agentId", requireRole("admin", "owner"), async (req, res, next) => {
  try {
    const agentId = String(req.params.agentId);
    const [existing] = await db
      .select()
      .from(agentsTable)
      .where(
        and(
          eq(agentsTable.id, agentId),
          eq(agentsTable.businessId, req.leadSprintBusinessId!),
        ),
      );

    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const {
      name,
      status,
      system_prompt,
      greeting_message,
      fallback_message,
      voice_id,
      language,
      temperature,
    } = req.body as Partial<{
      name: string;
      status: string;
      system_prompt: string;
      greeting_message: string;
      fallback_message: string;
      voice_id: string;
      language: string;
      temperature: number;
    }>;

    // Push to Retell if linked
    if (existing.retellAgentId) {
      const apiKey = await getTenantRetellKey(req.leadSprintBusinessId!);
      await updateRetellAgentPair({
        retellAgentId: existing.retellAgentId,
        retellLlmId: existing.retellLlmId ?? undefined,
        agentName: name,
        systemPrompt: system_prompt,
        greeting: greeting_message,
        fallbackMessage: fallback_message,
        voiceId: voice_id,
        language,
        temperature,
        apiKey,
      }).catch(() => {
        // Non-fatal: local DB updated even if Retell sync fails
      });
    }

    const [updated] = await db
      .update(agentsTable)
      .set({
        ...(name !== undefined && { name }),
        ...(status !== undefined && { status }),
        ...(system_prompt !== undefined && { systemPrompt: system_prompt }),
        ...(greeting_message !== undefined && { greeting: greeting_message }),
        ...(fallback_message !== undefined && { fallbackMessage: fallback_message }),
        ...(voice_id !== undefined && { voiceId: voice_id }),
        ...(language !== undefined && { language }),
        ...(temperature !== undefined && { voiceTemperature: String(temperature) }),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(agentsTable.id, agentId),
          eq(agentsTable.businessId, req.leadSprintBusinessId!),
        ),
      )
      .returning();

    res.json({ agent: agentToDetail(updated!) });
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) {
      res.status(503).json({ error: "Retell is not configured for this workspace" });
      return;
    }
    next(err);
  }
});

// ------ DELETE /agents/:agentId --------------------------------------------
router.delete("/agents/:agentId", requireRole("admin", "owner"), async (req, res, next) => {
  try {
    const agentId = String(req.params.agentId);
    const [existing] = await db
      .select()
      .from(agentsTable)
      .where(
        and(
          eq(agentsTable.id, agentId),
          eq(agentsTable.businessId, req.leadSprintBusinessId!),
        ),
      );

    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    // Delete from Retell if linked
    if (existing.retellAgentId) {
      const apiKey = await getTenantRetellKey(req.leadSprintBusinessId!);
      await deleteRetellAgent(existing.retellAgentId, apiKey).catch(() => {
        // Non-fatal
      });
    }

    await db
      .delete(agentsTable)
      .where(
        and(
          eq(agentsTable.id, agentId),
          eq(agentsTable.businessId, req.leadSprintBusinessId!),
        ),
      );

    res.json({ deleted_id: agentId });
  } catch (err) {
    next(err);
  }
});

// ------ POST /agents/:agentId/publish --------------------------------------
router.post("/agents/:agentId/publish", requireRole("admin", "owner"), async (req, res, next) => {
  try {
    const agentId = String(req.params.agentId);
    const [existing] = await db
      .select()
      .from(agentsTable)
      .where(
        and(
          eq(agentsTable.id, agentId),
          eq(agentsTable.businessId, req.leadSprintBusinessId!),
        ),
      );

    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    let versionNumber: number | null = null;
    if (existing.retellAgentId) {
      const apiKey = await getTenantRetellKey(req.leadSprintBusinessId!);
      const v = await publishRetellAgent(existing.retellAgentId, apiKey);
      versionNumber = v ?? null;
    }

    const publishedAt = new Date();
    const [versionCount] = await db
      .select({ count: sql<number>`count(*)` })
      .from(agentVersionsTable)
      .where(eq(agentVersionsTable.agentId, agentId));

    const nextVersion = (Number(versionCount?.count ?? 0)) + 1;

    await db.insert(agentVersionsTable).values({
      id: id("agv"),
      agentId,
      businessId: req.leadSprintBusinessId!,
      publishedByUserId: req.leadSprintUserId ?? null,
      versionNumber: versionNumber ?? nextVersion,
      retellVersion: versionNumber ?? null,
      snapshot: {
        systemPrompt: existing.systemPrompt,
        greeting: existing.greeting,
        voiceId: existing.voiceId,
      },
      publishedAt,
    });

    await db
      .update(agentsTable)
      .set({ status: "active", publishedVersion: versionNumber ?? nextVersion, updatedAt: publishedAt })
      .where(eq(agentsTable.id, agentId));

    res.json({
      version_number: versionNumber ?? nextVersion,
      published_at: publishedAt.toISOString(),
    });
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) {
      res.status(503).json({ error: "Retell is not configured for this workspace" });
      return;
    }
    if (err instanceof ProviderRequestError) {
      res.status(502).json({ error: err.message });
      return;
    }
    next(err);
  }
});

// ------ GET /agents/:agentId/versions --------------------------------------
router.get("/agents/:agentId/versions", requireRole("member", "manager", "admin", "owner"), async (req, res, next) => {
  try {
    const agentId = String(req.params.agentId);
    const [existing] = await db
      .select({ id: agentsTable.id })
      .from(agentsTable)
      .where(
        and(
          eq(agentsTable.id, agentId),
          eq(agentsTable.businessId, req.leadSprintBusinessId!),
        ),
      );

    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const versions = await db
      .select()
      .from(agentVersionsTable)
      .where(eq(agentVersionsTable.agentId, agentId))
      .orderBy(desc(agentVersionsTable.publishedAt));

    res.json({
      versions: versions.map((v) => ({
        id: v.id,
        version_number: v.versionNumber,
        published_by: v.publishedByUserId ?? "system",
        published_at: v.publishedAt.toISOString(),
        notes: v.notes ?? null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ------ POST /agents/:agentId/retell-link ----------------------------------
router.post("/agents/:agentId/retell-link", requireRole("admin", "owner"), async (req, res, next) => {
  try {
    const agentId = String(req.params.agentId);
    const [existing] = await db
      .select()
      .from(agentsTable)
      .where(
        and(
          eq(agentsTable.id, agentId),
          eq(agentsTable.businessId, req.leadSprintBusinessId!),
        ),
      );

    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const { retell_agent_id, retell_llm_id, status } = req.body as {
      retell_agent_id: string;
      retell_llm_id?: string;
      status?: "draft" | "active" | "paused";
    };

    if (!retell_agent_id) {
      res.status(400).json({ error: "retell_agent_id is required" });
      return;
    }

    const trimmedId = String(retell_agent_id).trim();
    const verification = await verifyRemoteRetellAgentExists(req.leadSprintBusinessId!, trimmedId);
    if (!verification.ok) {
      res.status(verification.status).json({ error: verification.error });
      return;
    }

    const nextStatus = status && ["draft", "active", "paused"].includes(status) ? status : existing.status;

    const [updated] = await db
      .update(agentsTable)
      .set({
        retellAgentId: trimmedId,
        retellLlmId: retell_llm_id ?? null,
        status: nextStatus,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(agentsTable.id, agentId),
          eq(agentsTable.businessId, req.leadSprintBusinessId!),
        ),
      )
      .returning();

    // Synchronize workspace default retellAgentId as well
    await db
      .update(businessesTable)
      .set({
        retellAgentId: retell_agent_id,
        updatedAt: new Date(),
      })
      .where(eq(businessesTable.id, req.leadSprintBusinessId!));

    res.json({ agent: agentToDetail(updated!) });
  } catch (err) {
    next(err);
  }
});

// ------ POST /agents/:agentId/test-web-call --------------------------------
router.post("/agents/:agentId/test-web-call", async (req, res, next) => {
  try {
    const agentId = String(req.params.agentId);
    const [existing] = await db
      .select()
      .from(agentsTable)
      .where(
        and(
          eq(agentsTable.id, agentId),
          eq(agentsTable.businessId, req.leadSprintBusinessId!),
        ),
      );

    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    if (!existing.retellAgentId) {
      res.status(409).json({ error: "Agent is not linked to a Retell agent" });
      return;
    }

    const apiKey = await getTenantRetellKey(req.leadSprintBusinessId!);
    const result = await createRetellWebCall(existing.retellAgentId, apiKey);
    res.json(result);
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) {
      res.status(503).json({ error: "Retell is not configured for this workspace" });
      return;
    }
    if (err instanceof ProviderRequestError) {
      res.status(502).json({ error: err.message });
      return;
    }
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Phone Number routes
// ---------------------------------------------------------------------------

// ------ GET /phone-numbers -------------------------------------------------
router.get("/phone-numbers", async (req, res, next) => {
  try {
    const rows = await db
      .select()
      .from(phoneNumbersTable)
      .where(eq(phoneNumbersTable.businessId, req.leadSprintBusinessId!))
      .orderBy(desc(phoneNumbersTable.createdAt));

    res.json({
      phone_numbers: rows.map((r) => ({
        id: r.id,
        e164_number: r.e164Number,
        nickname: r.nickname,
        inbound_agent_id: r.inboundAgentId,
        outbound_agent_id: r.outboundAgentId,
        is_active: r.status === "active",
        created_at: r.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ------ POST /phone-numbers/sync -------------------------------------------
router.post("/phone-numbers/sync", requireRole("admin", "owner"), async (req, res, next) => {
  try {
    const apiKey = await getTenantRetellKey(req.leadSprintBusinessId!);
    const remoteNums = await listRetellPhoneNumbers(apiKey);

    const upserted: Array<typeof phoneNumbersTable.$inferSelect> = [];

    for (const rn of remoteNums) {
      const phoneNumberId = id("pn");
      const [row] = await db
        .insert(phoneNumbersTable)
        .values({
          id: phoneNumberId,
          businessId: req.leadSprintBusinessId!,
          e164Number: rn.phone_number,
          nickname: rn.nickname ?? null,
          status: "active",
          provider: "retell",
          retellSyncedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: phoneNumbersTable.e164Number,
          set: {
            nickname: rn.nickname ?? null,
            status: "active",
            retellSyncedAt: new Date(),
            updatedAt: new Date(),
          },
        })
        .returning();
      if (row) upserted.push(row);
    }

    res.json({
      synced: upserted.length,
      phone_numbers: upserted.map((r) => ({
        id: r.id,
        e164_number: r.e164Number,
        nickname: r.nickname,
        inbound_agent_id: r.inboundAgentId,
        outbound_agent_id: r.outboundAgentId,
        is_active: r.status === "active",
        created_at: r.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) {
      res.status(503).json({ error: "Retell is not configured for this workspace" });
      return;
    }
    if (err instanceof ProviderRequestError) {
      res.status(502).json({ error: err.message });
      return;
    }
    next(err);
  }
});

// ------ PATCH /phone-numbers/:phoneNumberId --------------------------------
router.patch("/phone-numbers/:phoneNumberId", requireRole("admin", "owner"), async (req, res, next) => {
  try {
    const phoneNumberId = String(req.params.phoneNumberId);
    const [existing] = await db
      .select()
      .from(phoneNumbersTable)
      .where(
        and(
          eq(phoneNumbersTable.id, phoneNumberId),
          eq(phoneNumbersTable.businessId, req.leadSprintBusinessId!),
        ),
      );

    if (!existing) {
      res.status(404).json({ error: "Phone number not found" });
      return;
    }

    const { nickname, inbound_agent_id, outbound_agent_id } = req.body as {
      nickname?: string;
      inbound_agent_id?: string | null;
      outbound_agent_id?: string | null;
    };

    // Push binding to Retell if inbound/outbound changes
    if (inbound_agent_id !== undefined || outbound_agent_id !== undefined) {
      const apiKey = await getTenantRetellKey(req.leadSprintBusinessId!);

      let retellInboundId: string | null | undefined = undefined;
      let retellOutboundId: string | null | undefined = undefined;

      if (inbound_agent_id !== undefined) {
        if (inbound_agent_id === null) {
          retellInboundId = null;
        } else {
          const [a] = await db
            .select({ retellAgentId: agentsTable.retellAgentId })
            .from(agentsTable)
            .where(
              and(
                eq(agentsTable.id, inbound_agent_id),
                eq(agentsTable.businessId, req.leadSprintBusinessId!),
              ),
            );
          retellInboundId = a?.retellAgentId ?? null;
        }
      }

      if (outbound_agent_id !== undefined) {
        if (outbound_agent_id === null) {
          retellOutboundId = null;
        } else {
          const [a] = await db
            .select({ retellAgentId: agentsTable.retellAgentId })
            .from(agentsTable)
            .where(
              and(
                eq(agentsTable.id, outbound_agent_id),
                eq(agentsTable.businessId, req.leadSprintBusinessId!),
              ),
            );
          retellOutboundId = a?.retellAgentId ?? null;
        }
      }

      await updateRetellPhoneNumberBinding(
        existing.e164Number,
        {
          ...(retellInboundId !== undefined && { inbound_agent_id: retellInboundId }),
          ...(retellOutboundId !== undefined && { outbound_agent_id: retellOutboundId }),
        },
        apiKey,
      ).catch(() => {
        // Non-fatal
      });
    }

    const [updated] = await db
      .update(phoneNumbersTable)
      .set({
        ...(nickname !== undefined && { nickname }),
        ...(inbound_agent_id !== undefined && { inboundAgentId: inbound_agent_id }),
        ...(outbound_agent_id !== undefined && { outboundAgentId: outbound_agent_id }),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(phoneNumbersTable.id, phoneNumberId),
          eq(phoneNumbersTable.businessId, req.leadSprintBusinessId!),
        ),
      )
      .returning();

    res.json({
      phone_number: {
        id: updated!.id,
        e164_number: updated!.e164Number,
        nickname: updated!.nickname,
        inbound_agent_id: updated!.inboundAgentId,
        outbound_agent_id: updated!.outboundAgentId,
        is_active: updated!.status === "active",
        created_at: updated!.createdAt.toISOString(),
      },
    });
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) {
      res.status(503).json({ error: "Retell is not configured for this workspace" });
      return;
    }
    if (err instanceof ProviderRequestError) {
      res.status(502).json({ error: err.message });
      return;
    }
    next(err);
  }
});

export default router;
