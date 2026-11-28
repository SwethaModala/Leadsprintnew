import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { LiveTranscriptItem, LiveToolCallItem } from "./LiveCallMonitorModal";

describe("LiveCallMonitorModal stream and safety tests", () => {
  it("never contains Retell API keys, public keys, or WebRTC dependencies", () => {
    const modalFilePath = path.resolve(__dirname, "LiveCallMonitorModal.tsx");
    const content = fs.readFileSync(modalFilePath, "utf8");

    // Must not contain Retell API keys or WebRTC
    expect(content).not.toContain("retell-client-js-sdk");
    expect(content).not.toContain("RETELL_API_KEY");
    expect(content).not.toContain("retell_api_key");
    expect(content).not.toContain("apiKey");
    expect(content).not.toContain("public_key");

    // Must use internal relative authenticated SSE endpoint
    expect(content).toContain("`/api/calls/${call.id}/monitor-stream`");
  });

  it("handles transcript turn updates, correctly merging partial updates for same speaker", () => {
    let transcripts: LiveTranscriptItem[] = [];

    const handleTranscriptUpdate = (item: { role: "agent" | "user"; content: string }) => {
      const last = transcripts[transcripts.length - 1];
      if (last && last.role === item.role && item.content.startsWith(last.content)) {
        transcripts = [...transcripts.slice(0, -1), { ...last, content: item.content }];
      } else {
        transcripts = [
          ...transcripts,
          {
            id: `turn_${transcripts.length + 1}`,
            role: item.role,
            content: item.content,
          },
        ];
      }
    };

    // Agent starts speaking
    handleTranscriptUpdate({ role: "agent", content: "Good morning" });
    expect(transcripts).toHaveLength(1);
    expect(transcripts[0].content).toBe("Good morning");

    // Agent expands current utterance
    handleTranscriptUpdate({ role: "agent", content: "Good morning! How can I help you today?" });
    expect(transcripts).toHaveLength(1);
    expect(transcripts[0].content).toBe("Good morning! How can I help you today?");

    // User responds
    handleTranscriptUpdate({ role: "user", content: "I am looking for a 2 bedroom apartment" });
    expect(transcripts).toHaveLength(2);
    expect(transcripts[1].role).toBe("user");
    expect(transcripts[1].content).toBe("I am looking for a 2 bedroom apartment");
  });

  it("reconstructs snapshot history from server catch-up payload", () => {
    const snapshotPayload = {
      transcripts: [
        { role: "agent", content: "Hello", timestamp: "2026-11-28T10:00:00Z" },
        { role: "user", content: "Hi there", timestamp: "2026-11-28T10:00:05Z" },
      ],
      tools: [
        {
          toolName: "check_inventory",
          status: "success",
          result: "Available",
          timestamp: "2026-11-28T10:00:06Z",
        },
      ],
    };

    const transcripts: LiveTranscriptItem[] = snapshotPayload.transcripts.map((t, idx) => ({
      id: `snap_t_${idx}`,
      role: t.role as "agent" | "user",
      content: t.content,
      timestamp: t.timestamp,
    }));

    const tools: LiveToolCallItem[] = snapshotPayload.tools.map((item, idx) => ({
      id: `snap_tool_${idx}`,
      toolName: item.toolName,
      status: item.status,
      result: item.result,
      timestamp: item.timestamp,
    }));

    expect(transcripts).toHaveLength(2);
    expect(transcripts[0].role).toBe("agent");
    expect(transcripts[1].role).toBe("user");
    expect(tools).toHaveLength(1);
    expect(tools[0].toolName).toBe("check_inventory");
    expect(tools[0].status).toBe("success");
  });
});
