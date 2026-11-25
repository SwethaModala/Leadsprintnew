import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { customFetch, setAuthTokenGetter } from "@workspace/api-client-react";

describe("Clerk token bridge & customFetch", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    setAuthTokenGetter(null);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setAuthTokenGetter(null);
  });

  it("attaches Authorization: Bearer header when token getter supplies a token", async () => {
    let capturedHeaders: Headers | undefined;
    let capturedCredentials: RequestCredentials | undefined;

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers);
      capturedCredentials = init?.credentials;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    setAuthTokenGetter(async () => "clerk_mock_jwt_token_xyz");

    const result = await customFetch<{ ok: boolean }>("/api/auth/me");

    expect(result).toEqual({ ok: true });
    expect(capturedHeaders?.get("authorization")).toBe("Bearer clerk_mock_jwt_token_xyz");
    expect(capturedCredentials).toBe("same-origin");
  });

  it("does not attach Authorization header when token getter is null", async () => {
    let capturedHeaders: Headers | undefined;

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    setAuthTokenGetter(null);

    await customFetch<{ ok: boolean }>("/api/auth/me");

    expect(capturedHeaders?.has("authorization")).toBe(false);
  });

  it("preserves custom credentials option when provided", async () => {
    let capturedCredentials: RequestCredentials | undefined;

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedCredentials = init?.credentials;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await customFetch<{ ok: boolean }>("/api/auth/me", { credentials: "include" });

    expect(capturedCredentials).toBe("include");
  });
});
