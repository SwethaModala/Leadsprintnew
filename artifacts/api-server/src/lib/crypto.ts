import crypto from "node:crypto";

export class EncryptionNotConfiguredError extends Error {
  readonly status = 503;

  constructor(
    message = "APP_ENCRYPTION_KEY must be configured with a 32-byte key (64 hex chars or 44-char base64)",
  ) {
    super(message);
    this.name = "EncryptionNotConfiguredError";
  }
}

export class CredentialDecryptionError extends Error {
  readonly status = 500;

  constructor(message = "Unable to decrypt provider credential payload") {
    super(message);
    this.name = "CredentialDecryptionError";
  }
}

function decodeMasterKey(raw: string | undefined): Buffer | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;

  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    const buf = Buffer.from(trimmed, "hex");
    return buf.length === 32 ? buf : null;
  }

  try {
    const buf = Buffer.from(trimmed, "base64");
    if (buf.length === 32) return buf;
  } catch {
    // Fall through cleanly.
  }

  return null;
}

export function currentEncryptionKeyVersion(): number {
  const raw = process.env["APP_ENCRYPTION_KEY_VERSION"]?.trim();
  if (!raw) return 1;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

export function isEncryptionConfigured(): boolean {
  return decodeMasterKey(process.env["APP_ENCRYPTION_KEY"]) !== null;
}

function requireCurrentMasterKey(): { key: Buffer; version: number } {
  const key = decodeMasterKey(process.env["APP_ENCRYPTION_KEY"]);
  if (!key) throw new EncryptionNotConfiguredError();
  return { key, version: currentEncryptionKeyVersion() };
}

function candidateDecryptionKeys(version: number): Buffer[] {
  const keys: Buffer[] = [];
  const current = decodeMasterKey(process.env["APP_ENCRYPTION_KEY"]);
  const previous = decodeMasterKey(process.env["APP_ENCRYPTION_KEY_PREVIOUS"]);
  const curVer = currentEncryptionKeyVersion();

  if (version === curVer) {
    if (current) keys.push(current);
    if (previous) keys.push(previous);
  } else {
    if (previous) keys.push(previous);
    if (current) keys.push(current);
  }
  return keys;
}

/**
 * Encrypts sensitive JSON/string material using AES-256-GCM bound to AAD
 * (such as `${businessId}:${provider}`) so ciphertext cannot be moved
 * across tenants or providers. Fails closed if APP_ENCRYPTION_KEY is absent.
 */
export function encryptSecret(
  plaintext: string,
  aad: string,
): { ciphertext: string; keyVersion: number } {
  const { key, version } = requireCurrentMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  const envelope = [
    "enc",
    `v${version}`,
    iv.toString("base64url"),
    authTag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join(":");
  return { ciphertext: envelope, keyVersion: version };
}

/**
 * Decrypts an `enc:v{n}:...` AES-256-GCM envelope and authenticates AAD.
 * Throws EncryptionNotConfiguredError if no master key is configured, or
 * CredentialDecryptionError on auth tag mismatch / tampering / wrong tenant.
 */
export function decryptSecret(envelope: string, aad: string): string {
  const parts = envelope.split(":");
  if (parts.length !== 5 || parts[0] !== "enc" || !/^v\d+$/.test(parts[1] ?? "")) {
    throw new CredentialDecryptionError("Malformed encrypted credential format");
  }

  const version = Number(parts[1]!.slice(1));
  const iv = Buffer.from(parts[2]!, "base64url");
  const authTag = Buffer.from(parts[3]!, "base64url");
  const data = Buffer.from(parts[4]!, "base64url");
  if (iv.length !== 12 || authTag.length !== 16) {
    throw new CredentialDecryptionError("Invalid cipher parameters");
  }

  const keys = candidateDecryptionKeys(version);
  if (keys.length === 0) {
    throw new EncryptionNotConfiguredError();
  }

  for (const key of keys) {
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAAD(Buffer.from(aad, "utf8"));
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
      return decrypted.toString("utf8");
    } catch {
      // Try next rotation key if configured, otherwise fail closed below.
    }
  }

  throw new CredentialDecryptionError("Credential authentication failed");
}

export function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

export function timingSafeEqualString(a: string, b: string): boolean {
  const bufA = crypto.createHash("sha256").update(a, "utf8").digest();
  const bufB = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Returns a redacted display hint for UI / audit logs without leaking secrets.
 */
export function redactSecret(value: string | undefined | null): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "";
  if (trimmed.length <= 6) return "••••";
  return `••••${trimmed.slice(-4)}`;
}

