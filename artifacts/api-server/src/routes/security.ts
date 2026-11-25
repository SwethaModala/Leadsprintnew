import { Router, type IRouter, type Request, type Response } from "express";
import { db as defaultDb } from "@workspace/db";
import {
  CreateApiKeyBody,
  UpsertProviderCredentialsBody,
} from "@workspace/api-zod";
import { ADMIN_ROLES, requireRole } from "../middlewares/rbac";
import {
  createTenantApiKey,
  deleteTenantProviderCredential,
  isCredentialProvider,
  listTenantApiKeys,
  listTenantProviderCredentials,
  revokeTenantApiKey,
  SecurityServiceError,
  upsertTenantProviderCredential,
} from "../lib/security";
import { logger } from "../lib/logger";

type Database = typeof defaultDb;
let db: Database = defaultDb;

/** Test seam for swapping the database in isolated router tests. */
export function __setSecurityDb(next: Database): void {
  db = next;
}

export function __resetSecurityDb(): void {
  db = defaultDb;
}

const router: IRouter = Router();

function requireAdminActor(req: Request, res: Response): {
  userId: string;
  businessId: string;
} | null {
  if (!req.leadSprintUserId || !req.leadSprintBusinessId || !req.leadSprintRole) {
    res.status(401).json({ error: "Authentication required" });
    return null;
  }
  return {
    userId: req.leadSprintUserId,
    businessId: req.leadSprintBusinessId,
  };
}

function handleSecurityError(res: Response, err: unknown): void {
  if (err instanceof SecurityServiceError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  logger.error({ err }, "Unexpected security route error");
  res.status(500).json({ error: "Internal server error" });
}

router.get("/api-keys", requireRole(...ADMIN_ROLES), async (req, res): Promise<void> => {
  const actor = requireAdminActor(req, res);
  if (!actor) return;
  try {
    res.json(await listTenantApiKeys(db, actor.businessId));
  } catch (err) {
    handleSecurityError(res, err);
  }
});

router.post("/api-keys", requireRole(...ADMIN_ROLES), async (req, res): Promise<void> => {
  const actor = requireAdminActor(req, res);
  if (!actor) return;
  const parsed = CreateApiKeyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid API key request" });
    return;
  }
  try {
    const created = await createTenantApiKey(db, {
      businessId: actor.businessId,
      userId: actor.userId,
      name: parsed.data.name,
      scopes: parsed.data.scopes,
      expiresInDays: parsed.data.expires_in_days,
    });
    res.status(201).json(created);
  } catch (err) {
    handleSecurityError(res, err);
  }
});

router.delete("/api-keys/:keyId", requireRole(...ADMIN_ROLES), async (req, res): Promise<void> => {
  const actor = requireAdminActor(req, res);
  if (!actor) return;
  try {
    const revoked = await revokeTenantApiKey(db, {
      businessId: actor.businessId,
      userId: actor.userId,
      keyId: String(req.params.keyId),
    });
    res.json(revoked);
  } catch (err) {
    handleSecurityError(res, err);
  }
});

router.get("/credentials", requireRole(...ADMIN_ROLES), async (req, res): Promise<void> => {
  const actor = requireAdminActor(req, res);
  if (!actor) return;
  try {
    res.json(await listTenantProviderCredentials(db, actor.businessId));
  } catch (err) {
    handleSecurityError(res, err);
  }
});

router.put("/credentials/:provider", requireRole(...ADMIN_ROLES), async (req, res): Promise<void> => {
  const actor = requireAdminActor(req, res);
  if (!actor) return;
  const provider = String(req.params.provider);
  if (!isCredentialProvider(provider)) {
    res.status(400).json({ error: `Unsupported provider "${provider}"` });
    return;
  }
  const parsed = UpsertProviderCredentialsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid credential payload" });
    return;
  }
  try {
    const saved = await upsertTenantProviderCredential(db, {
      businessId: actor.businessId,
      userId: actor.userId,
      provider,
      config: parsed.data.config,
    });
    res.json(saved);
  } catch (err) {
    handleSecurityError(res, err);
  }
});

router.delete("/credentials/:provider", requireRole(...ADMIN_ROLES), async (req, res): Promise<void> => {
  const actor = requireAdminActor(req, res);
  if (!actor) return;
  const provider = String(req.params.provider);
  if (!isCredentialProvider(provider)) {
    res.status(400).json({ error: `Unsupported provider "${provider}"` });
    return;
  }
  try {
    const deleted = await deleteTenantProviderCredential(db, {
      businessId: actor.businessId,
      userId: actor.userId,
      provider,
    });
    res.json(deleted);
  } catch (err) {
    handleSecurityError(res, err);
  }
});

export default router;

