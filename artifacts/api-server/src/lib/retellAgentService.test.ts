import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
} from "./retellAgentService";
import { ProviderNotConfiguredError, ProviderRequestError } from "./providers";

describe("retellAgentService", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubEnv("RETELL_API_KEY", "key_global_retell");
    vi.stubEnv("RETELL_API_URL", "https://api.retellai.com");
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  describe("Credentials handling", () => {
    it("throws ProviderNotConfiguredError when RETELL_API_KEY is unset and no override", async () => {
      vi.stubEnv("RETELL_API_KEY", "");
      await expect(listRetellAgents()).rejects.toThrow(ProviderNotConfiguredError);
    });

    it("uses tenant apiKey override when provided", async () => {
      vi.stubEnv("RETELL_API_KEY", "");
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));

      const res = await listRetellAgents("key_tenant_custom");
      expect(res).toEqual([]);
      expect(fetchMock.mock.calls[0]?.[1]?.headers?.Authorization).toBe("Bearer key_tenant_custom");
    });
  });

  describe("Agent operations", () => {
    it("lists agents from Retell", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              agent_id: "retell_1",
              agent_name: "Sales Agent",
              response_engine: { type: "retell-llm", llm_id: "llm_1" },
              voice_id: "11labs-Adrian",
              language: "en-US",
              last_modification_timestamp: 1700000000000,
            },
          ]),
          { status: 200 },
        ),
      );

      const agents = await listRetellAgents();
      expect(agents).toHaveLength(1);
      expect(agents[0].retell_agent_id).toBe("retell_1");
      expect(agents[0].agent_name).toBe("Sales Agent");
    });

    it("creates an LLM and Agent pair atomically", async () => {
      // 1. LLM creation response
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ llm_id: "llm_created_1" }), { status: 201 }),
      );
      // 2. Agent creation response
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ agent_id: "agent_created_1" }), { status: 201 }),
      );

      const result = await createRetellAgentPair({
        agentName: "Support Bot",
        systemPrompt: "You are a friendly support assistant.",
        greeting: "Hello, how can I help you?",
        voiceId: "11labs-Adrian",
        language: "en-US",
      });

      expect(result).toEqual({
        retellAgentId: "agent_created_1",
        retellLlmId: "llm_created_1",
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][0]).toContain("/v2/create-retell-llm");
      expect(fetchMock.mock.calls[1][0]).toContain("/v2/create-agent");
    });

    it("rolls back created LLM if agent creation fails", async () => {
      // 1. LLM creation succeeds
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ llm_id: "llm_orphaned_123" }), { status: 201 }),
      );
      // 2. Agent creation fails
      fetchMock.mockResolvedValueOnce(
        new Response("Invalid voiceId", { status: 400 }),
      );
      // 3. Rollback delete-retell-llm succeeds
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

      await expect(
        createRetellAgentPair({
          agentName: "Failing Bot",
          systemPrompt: "Prompt",
          greeting: "Hi",
        }),
      ).rejects.toThrow(ProviderRequestError);

      // Verify that rollback delete was called
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(fetchMock.mock.calls[2][0]).toContain("/v2/delete-retell-llm/llm_orphaned_123");
      expect(fetchMock.mock.calls[2][1].method).toBe("DELETE");
    });

    it("updates agent and LLM pair", async () => {
      fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));
      fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));

      await updateRetellAgentPair({
        retellAgentId: "agent_1",
        retellLlmId: "llm_1",
        agentName: "Updated Name",
        systemPrompt: "Updated Prompt",
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][0]).toContain("/v2/update-agent/agent_1");
      expect(fetchMock.mock.calls[1][0]).toContain("/v2/update-retell-llm/llm_1");
    });

    it("deletes an agent", async () => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
      await deleteRetellAgent("agent_to_delete");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toContain("/v2/delete-agent/agent_to_delete");
    });

    it("publishes an agent and returns version", async () => {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ version: 3 }), { status: 200 }));
      const version = await publishRetellAgent("agent_to_publish");
      expect(version).toBe(3);
    });

    it("wraps API HTTP error into ProviderRequestError", async () => {
      fetchMock.mockResolvedValueOnce(new Response("Bad Request", { status: 400 }));
      await expect(listRetellAgents()).rejects.toThrow(ProviderRequestError);
    });
  });

  describe("Voices & Phone numbers", () => {
    it("lists voices", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { voice_id: "voice_1", voice_name: "Adrian", provider: "elevenlabs" },
          ]),
          { status: 200 },
        ),
      );

      const voices = await listRetellVoices();
      expect(voices).toHaveLength(1);
      expect(voices[0].voice_name).toBe("Adrian");
    });

    it("lists and updates phone number binding", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { phone_number: "+14155550100", nickname: "Office line" },
          ]),
          { status: 200 },
        ),
      );
      fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));

      const nums = await listRetellPhoneNumbers();
      expect(nums).toHaveLength(1);

      await updateRetellPhoneNumberBinding("+14155550100", {
        inbound_agent_id: "agent_inbound_1",
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1][0]).toContain(encodeURIComponent("+14155550100"));
    });

    it("creates a web-call test", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: "jwt_token_123", call_id: "call_web_123" }),
          { status: 201 },
        ),
      );

      const res = await createRetellWebCall("agent_web_test");
      expect(res).toEqual({
        access_token: "jwt_token_123",
        call_id: "call_web_123",
      });
    });
  });
});
