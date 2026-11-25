import crypto from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import {
  apiKeysTable,
  auditLogsTable,
  db as defaultDb,
  providerCredentialsTable,
} from "@workspace/db";
import {
  CredentialDecryptionError,
  decryptSecret,
  EncryptionNotConfiguredError,
  encryptSecret,
  isEncryptionConfigured,
  redactSecret,
  sha256Hex,
} from "./crypto";

type Database = typeof defaultDb;

export const CREDENTIAL_PROVIDERS = ["retell", "twilio", "calcom", "intake"] as const;
export type CredentialProvider = (typeof CREDENTIAL_PROVIDERS)[number];

export const ALLOWED_API_KEY_SCOPES = [
  "leads:intake",
  "leads:read",
  "calls:read",
  "*",
] as const;

const PROVIDER_ALLOWED_FIELDS: Record<CredentialProvider, readonly string[]> = {
  retell: [
    "api_key",
    "webhook_secret",
    "agent_id",
    "from_number",
    "from_number_us",
    "from_number_in",
    "api_url",
  ],
  twilio: [
    "account_sid",
    "auth_token",
    "webhook_secret",
    "us_from_number",
    "india_from_number",
  ],
  calcom: ["api_key", "event_type_id", "webhook_secret", "api_url"],
  intake: ["webhook_secret"],
};

const PROVIDER_SECRET_FIELDS: Record<CredentialProvider, ReadonlySet<string>> = {
  retell: new Set(["api_key", "webhook_secret"]),
  twilio: new Set(["auth_token", "webhook_secret"]),
  calcom: new Set(["api_key", "webhook_secret"]),
  intake: new Set(["webhook_secret"]),
};

export class SecurityServiceError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SecurityServiceError";
  }
}

function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function credentialAad(businessId: string, provider: CredentialProvider): string {
  return `${businessId}:${provider}`;
}

export function isCredentialProvider(value: string): value is CredentialProvider {
  return (CREDENTIAL_PROVIDERS as readonly string[]).includes(value);
}

export async function createTenantApiKey(
  database: Database,
  input: {
    businessId: string;
    userId: string;
    name: string;
    scopes?: string[];
    expiresInDays?: number;
  },
) {
  const trimmedName = input.name.trim();
  if (trimmedName.length < 2 || trimmedName.length > 80) {
    throw new SecurityServiceError(400, "API key name must be between 2 and 80 characters");
  }

  const requestedScopes =
    input.scopes && input.scopes.length > 0 ? input.scopes : ["leads:intake"];
  const validScopes = Array.from(new Set(requestedScopes.map((s) => s.trim()))).filter(Boolean);
  for (const scope of validScopes) {
    if (!(ALLOWED_API_KEY_SCOPES as readonly string[]).includes(scope)) {
      throw new SecurityServiceError(400, `Unsupported API key scope "${scope}"`);
    }
  }

  const rawKey = `ls_live_${crypto.randomBytes(24).toString("base64url")}`;
  const keyPrefix = rawKey.slice(0, 16);
  const keyHash = sha256Hex(rawKey);
  const expiresAt =
    typeof input.expiresInDays === "number"
      ? new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000)
      : null;

  const created = await database.transaction(async (tx) => {
    const [row] = await tx
      .insert(apiKeysTable)
      .values({
        id: makeId("key"),
        businessId: input.businessId,
        createdByUserId: input.userId,
        name: trimmedName,
        keyPrefix,
        keyHash,
        scopes: validScopes,
        expiresAt,
      })
      .returning();

    await tx.insert(auditLogsTable).values({
      id: makeId("audit"),
      businessId: input.businessId,
      userId: input.userId,
      entity: "api_key",
      entityId: row!.id,
      action: "api_key.created",
      details: { name: trimmedName, key_prefix: keyPrefix, scopes: validScopes },
    });

    return row!;
  });

  return {
    api_key: {
      id: created.id,
      name: created.name,
      key_prefix: created.keyPrefix,
      scopes: created.scopes,
      last_used_at: null,
      expires_at: created.expiresAt ? created.expiresAt.toISOString() : null,
      revoked_at: null,
      created_at: created.createdAt.toISOString(),
    },
    secret_key: rawKey,
  };
}

export async function listTenantApiKeys(database: Database, businessId: string) {
  const rows = await database
    .select({
      id: apiKeysTable.id,
      name: apiKeysTable.name,
      keyPrefix: apiKeysTable.keyPrefix,
      scopes: apiKeysTable.scopes,
      lastUsedAt: apiKeysTable.lastUsedAt,
      expiresAt: apiKeysTable.expiresAt,
      revokedAt: apiKeysTable.revokedAt,
      createdAt: apiKeysTable.createdAt,
    })
    .from(apiKeysTable)
    .where(eq(apiKeysTable.businessId, businessId))
    .orderBy(desc(apiKeysTable.createdAt));

  return {
    keys: rows.map((row) => ({
      id: row.id,
      name: row.name,
      key_prefix: row.keyPrefix,
      scopes: row.scopes,
      last_used_at: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
      expires_at: row.expiresAt ? row.expiresAt.toISOString() : null,
      revoked_at: row.revokedAt ? row.revokedAt.toISOString() : null,
      created_at: row.createdAt.toISOString(),
    })),
  };
}

export async function revokeTenantApiKey(
  database: Database,
  input: { businessId: string; userId: string; keyId: string },
) {
  return database.transaction(async (tx) => {
    const [existing] = await tx
      .select({
        id: apiKeysTable.id,
        name: apiKeysTable.name,
        keyPrefix: apiKeysTable.keyPrefix,
        revokedAt: apiKeysTable.revokedAt,
      })
      .from(apiKeysTable)
      .where(
        and(
          eq(apiKeysTable.id, input.keyId),
          eq(apiKeysTable.businessId, input.businessId),
        ),
      )
      .limit(1);

    if (!existing) {
      throw new SecurityServiceError(404, "API key not found");
    }

    const revokedAt = existing.revokedAt ?? new Date();
    if (!existing.revokedAt) {
      await tx
        .update(apiKeysTable)
        .set({ revokedAt })
        .where(
          and(
            eq(apiKeysTable.id, existing.id),
            eq(apiKeysTable.businessId, input.businessId),
          ),
        );

      await tx.insert(auditLogsTable).values({
        id: makeId("audit"),
        businessId: input.businessId,
        userId: input.userId,
        entity: "api_key",
        entityId: existing.id,
        action: "api_key.revoked",
        details: { name: existing.name, key_prefix: existing.keyPrefix },
      });
    }

    return {
      revoked_key_id: existing.id,
      revoked_at: revokedAt.toISOString(),
    };
  });
}

export async function authenticateTenantApiKey(
  database: Database,
  rawKey: string | undefined,
  requiredScope = "leads:intake",
): Promise<{ businessId: string; keyId: string; scopes: string[] } | null> {
  const token = rawKey?.trim() ?? "";
  if (!token.startsWith("ls_live_") || token.length < 24) {
    return null;
  }

  const keyHash = sha256Hex(token);
  const [row] = await database
    .select({
      id: apiKeysTable.id,
      businessId: apiKeysTable.businessId,
      scopes: apiKeysTable.scopes,
      revokedAt: apiKeysTable.revokedAt,
      expiresAt: apiKeysTable.expiresAt,
    })
    .from(apiKeysTable)
    .where(eq(apiKeysTable.keyHash, keyHash))
    .limit(1);

  if (!row || row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;
  if (!row.scopes.includes(requiredScope) && !row.scopes.includes("*")) return null;

  await database
    .update(apiKeysTable)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeysTable.id, row.id));

  return {
    businessId: row.businessId,
    keyId: row.id,
    scopes: row.scopes,
  };
}

function buildMaskedHints(
  provider: CredentialProvider,
  config: Record<string, string>,
): Record<string, string> {
  const secretSet = PROVIDER_SECRET_FIELDS[provider];
  const hints: Record<string, string> = {};
  for (const [key, value] of Object.entries(config)) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    hints[key] = secretSet.has(key) ? redactSecret(trimmed) : trimmed;
  }
  return hints;
}

export async function loadTenantProviderSecrets(
  database: Database,
  businessId: string,
  provider: CredentialProvider,
): Promise<Record<string, string> | null> {
  const [row] = await database
    .select({
      encryptedConfig: providerCredentialsTable.encryptedConfig,
    })
    .from(providerCredentialsTable)
    .where(
      and(
        eq(providerCredentialsTable.businessId, businessId),
        eq(providerCredentialsTable.provider, provider),
      ),
    )
    .limit(1);

  if (!row) return null;
  const json = decryptSecret(row.encryptedConfig, credentialAad(businessId, provider));
  const parsed = JSON.parse(json) as Record<string, unknown>;
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === "string" && v.trim()) {
      result[k] = v.trim();
    }
  }
  return result;
}

export async function upsertTenantProviderCredential(
  database: Database,
  input: {
    businessId: string;
    userId: string;
    provider: CredentialProvider;
    config: Record<string, string>;
  },
) {
  const allowed = PROVIDER_ALLOWED_FIELDS[input.provider];
  for (const key of Object.keys(input.config)) {
    if (!allowed.includes(key)) {
      throw new SecurityServiceError(
        400,
        `Field "${key}" is not valid for provider "${input.provider}"`,
      );
    }
  }

  let existingConfig: Record<string, string> = {};
  try {
    const loaded = await loadTenantProviderSecrets(database, input.businessId, input.provider);
    if (loaded) existingConfig = loaded;
  } catch (err) {
    if (err instanceof EncryptionNotConfiguredError) {
      throw new SecurityServiceError(503, err.message);
    }
    if (err instanceof CredentialDecryptionError) {
      // Allow admin to overwrite corrupted/unreadable key material intentionally.
      existingConfig = {};
    } else {
      throw err;
    }
  }

  const merged: Record<string, string> = { ...existingConfig };
  for (const [key, rawVal] of Object.entries(input.config)) {
    const val = rawVal.trim();
    if (!val) {
      delete merged[key];
    } else {
      merged[key] = val;
    }
  }

  if (Object.keys(merged).length === 0) {
    throw new SecurityServiceError(400, "At least one non-empty credential field is required");
  }

  let ciphertext: string;
  let keyVersion: number;
  try {
    const encrypted = encryptSecret(
      JSON.stringify(merged),
      credentialAad(input.businessId, input.provider),
    );
    ciphertext = encrypted.ciphertext;
    keyVersion = encrypted.keyVersion;
  } catch (err) {
    if (err instanceof EncryptionNotConfiguredError) {
      throw new SecurityServiceError(503, err.message);
    }
    throw err;
  }

  const maskedHints = buildMaskedHints(input.provider, merged);

  const saved = await database.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: providerCredentialsTable.id })
      .from(providerCredentialsTable)
      .where(
        and(
          eq(providerCredentialsTable.businessId, input.businessId),
          eq(providerCredentialsTable.provider, input.provider),
        ),
      )
      .limit(1);

    const row = existing
      ? (
          await tx
            .update(providerCredentialsTable)
            .set({
              encryptedConfig: ciphertext,
              keyVersion,
              metadata: { masked_hints: maskedHints },
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(providerCredentialsTable.id, existing.id),
                eq(providerCredentialsTable.businessId, input.businessId),
              ),
            )
            .returning()
        )[0]!
      : (
          await tx
            .insert(providerCredentialsTable)
            .values({
              id: makeId("cred"),
              businessId: input.businessId,
              provider: input.provider,
              encryptedConfig: ciphertext,
              keyVersion,
              metadata: { masked_hints: maskedHints },
            })
            .returning()
        )[0]!;

    await tx.insert(auditLogsTable).values({
      id: makeId("audit"),
      businessId: input.businessId,
      userId: input.userId,
      entity: "provider_credential",
      entityId: row.id,
      action: "credentials.updated",
      details: {
        provider: input.provider,
        key_version: keyVersion,
        fields: Object.keys(merged),
      },
    });

    return row;
  });

  return {
    credential: {
      provider: input.provider,
      configured: true,
      key_version: saved.keyVersion,
      masked_hints: maskedHints,
      updated_at: saved.updatedAt.toISOString(),
    },
  };
}

export async function listTenantProviderCredentials(
  database: Database,
  businessId: string,
) {
  const rows = await database
    .select({
      provider: providerCredentialsTable.provider,
      keyVersion: providerCredentialsTable.keyVersion,
      metadata: providerCredentialsTable.metadata,
      updatedAt: providerCredentialsTable.updatedAt,
    })
    .from(providerCredentialsTable)
    .where(eq(providerCredentialsTable.businessId, businessId));

  const byProvider = new Map(rows.map((r) => [r.provider, r]));

  return {
    encryption_configured: isEncryptionConfigured(),
    credentials: CREDENTIAL_PROVIDERS.map((provider) => {
      const row = byProvider.get(provider);
      const rawHints =
        row?.metadata &&
        typeof row.metadata === "object" &&
        "masked_hints" in row.metadata &&
        row.metadata.masked_hints &&
        typeof row.metadata.masked_hints === "object"
          ? (row.metadata.masked_hints as Record<string, string>)
          : {};
      return {
        provider,
        configured: Boolean(row),
        key_version: row ? row.keyVersion : null,
        masked_hints: rawHints,
        updated_at: row ? row.updatedAt.toISOString() : null,
      };
    }),
  };
}

export async function deleteTenantProviderCredential(
  database: Database,
  input: { businessId: string; userId: string; provider: CredentialProvider },
) {
  return database.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: providerCredentialsTable.id })
      .from(providerCredentialsTable)
      .where(
        and(
          eq(providerCredentialsTable.businessId, input.businessId),
          eq(providerCredentialsTable.provider, input.provider),
        ),
      )
      .limit(1);

    if (!existing) {
      throw new SecurityServiceError(404, `No stored credentials for "${input.provider}"`);
    }

    await tx
      .delete(providerCredentialsTable)
      .where(
        and(
          eq(providerCredentialsTable.id, existing.id),
          eq(providerCredentialsTable.businessId, input.businessId),
        ),
      );

    await tx.insert(auditLogsTable).values({
      id: makeId("audit"),
      businessId: input.businessId,
      userId: input.userId,
      entity: "provider_credential",
      entityId: existing.id,
      action: "credentials.deleted",
      details: { provider: input.provider },
    });

    return { deleted_provider: input.provider };
  });
}

