/**
 * Retell Agent & Phone-Number sync service.
 *
 * Uses direct fetch calls to Retell REST API endpoints.
 * Errors are wrapped into typed ProviderRequestError / ProviderNotConfiguredError.
 */

import { providerConfig, ProviderNotConfiguredError, ProviderRequestError } from "./providers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getRetellCredentials(apiKeyOverride?: string): { apiKey: string; apiUrl: string } {
  const base = providerConfig().retell;
  const apiKey = apiKeyOverride ?? base.apiKey;
  if (!apiKey) throw new ProviderNotConfiguredError("Retell", ["RETELL_API_KEY"]);
  return { apiKey, apiUrl: base.apiUrl ?? "https://api.retellai.com" };
}

async function retellFetch<T>(
  endpoint: string,
  options: {
    method?: string;
    body?: unknown;
    apiKey?: string;
  } = {},
): Promise<T> {
  const { apiKey, apiUrl } = getRetellCredentials(options.apiKey);
  const url = `${apiUrl.replace(/\/$/, "")}${endpoint.startsWith("/") ? "" : "/"}${endpoint}`;
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new ProviderRequestError(`Retell API error (${response.status}): ${errorText}`);
  }

  // Handle 204 or empty response
  const text = await response.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return {} as T;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RetellAgentSummary {
  retell_agent_id: string;
  agent_name: string;
  response_engine: { type: string; llm_id?: string };
  voice_id: string;
  language: string;
  last_modification_timestamp: number;
}

export interface RetellVoiceSummary {
  voice_id: string;
  voice_name: string;
  provider: string;
  accent?: string;
  gender?: string;
  age?: string;
  preview_audio_url?: string;
}

export interface RetellPhoneNumberSummary {
  phone_number: string;
  phone_number_pretty?: string;
  inbound_agent_id?: string;
  outbound_agent_id?: string;
  nickname?: string;
  area_code?: number;
  last_modification_timestamp?: number;
}

export interface CreateRetellAgentInput {
  agentName: string;
  systemPrompt: string;
  greeting: string;
  fallbackMessage?: string;
  voiceId?: string;
  language?: string;
  temperature?: number;
  apiKey?: string;
}

export interface UpdateRetellAgentInput {
  retellAgentId: string;
  retellLlmId?: string;
  agentName?: string;
  systemPrompt?: string;
  greeting?: string;
  fallbackMessage?: string;
  voiceId?: string;
  language?: string;
  temperature?: number;
  apiKey?: string;
}

// ---------------------------------------------------------------------------
// Agent operations
// ---------------------------------------------------------------------------

export async function listRetellAgents(apiKey?: string): Promise<RetellAgentSummary[]> {
  try {
    const list = await retellFetch<any[]>("/v2/list-agents", { apiKey });
    return (list ?? []).map((a: any) => ({
      retell_agent_id: a.agent_id,
      agent_name: a.agent_name ?? "",
      response_engine: a.response_engine ?? { type: "retell-llm" },
      voice_id: a.voice_id ?? "",
      language: a.language ?? "en-US",
      last_modification_timestamp: a.last_modification_timestamp ?? Date.now(),
    }));
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) throw err;
    throw new ProviderRequestError(
      `Retell agent list failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Create a Retell LLM + Agent pair for a LeadSprint workspace agent.
 */
export async function createRetellAgentPair(
  input: CreateRetellAgentInput,
): Promise<{ retellAgentId: string; retellLlmId: string }> {
  let createdLlmId: string | null = null;
  try {
    // 1. Create the LLM (response engine)
    const llm = await retellFetch<{ llm_id: string }>("/v2/create-retell-llm", {
      method: "POST",
      apiKey: input.apiKey,
      body: {
        general_prompt: input.systemPrompt,
        begin_message: input.greeting,
        general_tools: [],
      },
    });
    createdLlmId = llm.llm_id;

    // 2. Create the agent referencing the LLM
    const agent = await retellFetch<{ agent_id: string }>("/v2/create-agent", {
      method: "POST",
      apiKey: input.apiKey,
      body: {
        agent_name: input.agentName,
        response_engine: { type: "retell-llm", llm_id: llm.llm_id },
        voice_id: input.voiceId ?? "11labs-Adrian",
        language: input.language ?? "en-US",
      },
    });

    return { retellAgentId: agent.agent_id, retellLlmId: llm.llm_id };
  } catch (err) {
    // Rollback orphaned LLM if step 2 failed
    if (createdLlmId) {
      await retellFetch(`/v2/delete-retell-llm/${encodeURIComponent(createdLlmId)}`, {
        method: "DELETE",
        apiKey: input.apiKey,
      }).catch(() => {
        // Best-effort cleanup
      });
    }

    if (err instanceof ProviderNotConfiguredError) throw err;
    throw new ProviderRequestError(
      `Retell agent creation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function updateRetellAgentPair(input: UpdateRetellAgentInput): Promise<void> {
  try {
    const agentUpdates: Record<string, unknown> = {};
    if (input.agentName) agentUpdates.agent_name = input.agentName;
    if (input.voiceId) agentUpdates.voice_id = input.voiceId;
    if (input.language) agentUpdates.language = input.language;

    if (Object.keys(agentUpdates).length > 0) {
      await retellFetch(`/v2/update-agent/${encodeURIComponent(input.retellAgentId)}`, {
        method: "PATCH",
        apiKey: input.apiKey,
        body: agentUpdates,
      });
    }

    if (input.retellLlmId) {
      const llmUpdates: Record<string, unknown> = {};
      if (input.systemPrompt !== undefined) llmUpdates.general_prompt = input.systemPrompt;
      if (input.greeting !== undefined) llmUpdates.begin_message = input.greeting;
      if (Object.keys(llmUpdates).length > 0) {
        await retellFetch(`/v2/update-retell-llm/${encodeURIComponent(input.retellLlmId)}`, {
          method: "PATCH",
          apiKey: input.apiKey,
          body: llmUpdates,
        });
      }
    }
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) throw err;
    throw new ProviderRequestError(
      `Retell agent update failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function deleteRetellAgent(retellAgentId: string, apiKey?: string): Promise<void> {
  try {
    await retellFetch(`/v2/delete-agent/${encodeURIComponent(retellAgentId)}`, {
      method: "DELETE",
      apiKey,
    });
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) throw err;
    throw new ProviderRequestError(
      `Retell agent delete failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function publishRetellAgent(
  retellAgentId: string,
  apiKey?: string,
): Promise<number | undefined> {
  try {
    const result = await retellFetch<{ version?: number }>(
      `/v2/publish-agent/${encodeURIComponent(retellAgentId)}`,
      {
        method: "POST",
        apiKey,
      },
    );
    return result?.version;
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) throw err;
    throw new ProviderRequestError(
      `Retell publish failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function getRetellAgent(retellAgentId: string, apiKey?: string) {
  try {
    return await retellFetch<any>(`/v2/get-agent/${encodeURIComponent(retellAgentId)}`, {
      apiKey,
    });
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) throw err;
    throw new ProviderRequestError(
      `Retell agent retrieve failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Voice list
// ---------------------------------------------------------------------------

export async function listRetellVoices(apiKey?: string): Promise<RetellVoiceSummary[]> {
  try {
    const voices = await retellFetch<any[]>("/v2/list-voices", { apiKey });
    return (voices ?? []).map((v: any) => ({
      voice_id: v.voice_id,
      voice_name: v.voice_name ?? v.voice_id,
      provider: v.provider ?? "elevenlabs",
      accent: v.accent,
      gender: v.gender,
      age: v.age,
      preview_audio_url: v.preview_audio_url,
    }));
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) throw err;
    throw new ProviderRequestError(
      `Retell voice list failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Phone numbers
// ---------------------------------------------------------------------------

export async function listRetellPhoneNumbers(apiKey?: string): Promise<RetellPhoneNumberSummary[]> {
  try {
    const nums = await retellFetch<any[]>("/v2/list-phone-numbers", { apiKey });
    return (nums ?? []).map((n: any) => ({
      phone_number: n.phone_number,
      phone_number_pretty: n.phone_number_pretty,
      inbound_agent_id: n.inbound_agent_id ?? undefined,
      outbound_agent_id: n.outbound_agent_id ?? undefined,
      nickname: n.nickname ?? undefined,
      area_code: n.area_code,
      last_modification_timestamp: n.last_modification_timestamp,
    }));
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) throw err;
    throw new ProviderRequestError(
      `Retell phone number list failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function updateRetellPhoneNumberBinding(
  e164Number: string,
  binding: { inbound_agent_id?: string | null; outbound_agent_id?: string | null },
  apiKey?: string,
): Promise<void> {
  try {
    await retellFetch(`/v2/update-phone-number/${encodeURIComponent(e164Number)}`, {
      method: "PATCH",
      apiKey,
      body: binding,
    });
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) throw err;
    throw new ProviderRequestError(
      `Retell phone number update failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Create a Retell web-call (browser sandbox test call).
 */
export async function createRetellWebCall(
  retellAgentId: string,
  apiKey?: string,
): Promise<{ access_token: string; call_id: string }> {
  try {
    const result = await retellFetch<{ access_token: string; call_id: string }>(
      "/v2/create-web-call",
      {
        method: "POST",
        apiKey,
        body: { agent_id: retellAgentId },
      },
    );
    return {
      access_token: result.access_token,
      call_id: result.call_id,
    };
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) throw err;
    throw new ProviderRequestError(
      `Retell web-call creation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
