import { afterEach, describe, expect, it } from "vitest";
import {
  CredentialDecryptionError,
  decryptSecret,
  EncryptionNotConfiguredError,
  encryptSecret,
  isEncryptionConfigured,
  redactSecret,
  sha256Hex,
  timingSafeEqualString,
} from "./crypto";

const KEY_V1_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const KEY_V2_B64 = Buffer.from(
  "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
  "hex",
).toString("base64");

afterEach(() => {
  delete process.env["APP_ENCRYPTION_KEY"];
  delete process.env["APP_ENCRYPTION_KEY_VERSION"];
  delete process.env["APP_ENCRYPTION_KEY_PREVIOUS"];
});

describe("AES-256-GCM credential encryption", () => {
  it("fails closed when APP_ENCRYPTION_KEY is missing or malformed", () => {
    delete process.env["APP_ENCRYPTION_KEY"];
    expect(isEncryptionConfigured()).toBe(false);
    expect(() => encryptSecret("secret", "biz_1:retell")).toThrow(
      EncryptionNotConfiguredError,
    );

    process.env["APP_ENCRYPTION_KEY"] = "too-short";
    expect(isEncryptionConfigured()).toBe(false);
    expect(() => encryptSecret("secret", "biz_1:retell")).toThrow(
      EncryptionNotConfiguredError,
    );
  });

  it("encrypts and decrypts payloads using both 64-char hex and 32-byte base64 keys", () => {
    process.env["APP_ENCRYPTION_KEY"] = KEY_V1_HEX;
    expect(isEncryptionConfigured()).toBe(true);

    const enc1 = encryptSecret('{"api_key":"retell_live_123"}', "biz_a:retell");
    expect(enc1.ciphertext.startsWith("enc:v1:")).toBe(true);
    expect(enc1.ciphertext).not.toContain("retell_live_123");
    expect(decryptSecret(enc1.ciphertext, "biz_a:retell")).toBe(
      '{"api_key":"retell_live_123"}',
    );

    process.env["APP_ENCRYPTION_KEY"] = KEY_V2_B64;
    const enc2 = encryptSecret("cal_secret_abc", "biz_a:calcom");
    expect(decryptSecret(enc2.ciphertext, "biz_a:calcom")).toBe("cal_secret_abc");
  });

  it("rejects cross-tenant AAD mismatches and tampered ciphertexts", () => {
    process.env["APP_ENCRYPTION_KEY"] = KEY_V1_HEX;
    const { ciphertext } = encryptSecret("secret_payload", "biz_alpha:intake");

    expect(() => decryptSecret(ciphertext, "biz_beta:intake")).toThrow(
      CredentialDecryptionError,
    );
    expect(() => decryptSecret(ciphertext, "biz_alpha:retell")).toThrow(
      CredentialDecryptionError,
    );

    const parts = ciphertext.split(":");
    parts[4] = parts[4]!.slice(0, -2) + "AA";
    expect(() => decryptSecret(parts.join(":"), "biz_alpha:intake")).toThrow(
      CredentialDecryptionError,
    );
  });

  it("supports zero-downtime key rotation via APP_ENCRYPTION_KEY_PREVIOUS", () => {
    process.env["APP_ENCRYPTION_KEY"] = KEY_V1_HEX;
    process.env["APP_ENCRYPTION_KEY_VERSION"] = "1";
    const v1 = encryptSecret("legacy_retell_key", "biz_a:retell");

    process.env["APP_ENCRYPTION_KEY"] = KEY_V2_B64;
    process.env["APP_ENCRYPTION_KEY_VERSION"] = "2";
    process.env["APP_ENCRYPTION_KEY_PREVIOUS"] = KEY_V1_HEX;

    expect(decryptSecret(v1.ciphertext, "biz_a:retell")).toBe("legacy_retell_key");

    const v2 = encryptSecret("rotated_retell_key", "biz_a:retell");
    expect(v2.keyVersion).toBe(2);
    expect(v2.ciphertext.startsWith("enc:v2:")).toBe(true);
    expect(decryptSecret(v2.ciphertext, "biz_a:retell")).toBe("rotated_retell_key");
  });

  it("redacts secrets and compares strings in constant time", () => {
    expect(redactSecret("ls_live_abcdef123456")).toBe("••••3456");
    expect(redactSecret("short")).toBe("••••");
    expect(redactSecret("")).toBe("");
    expect(sha256Hex("abc")).toHaveLength(64);
    expect(timingSafeEqualString("secret_1", "secret_1")).toBe(true);
    expect(timingSafeEqualString("secret_1", "secret_2")).toBe(false);
  });
});

