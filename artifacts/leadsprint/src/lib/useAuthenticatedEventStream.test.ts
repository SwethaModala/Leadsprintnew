import { describe, expect, it, vi } from "vitest";
import {
  parseSSEBlock,
  consumeEventStream,
  LiveEvent,
} from "./useAuthenticatedEventStream";

describe("useAuthenticatedEventStream parser and stream reader", () => {
  describe("parseSSEBlock", () => {
    it("ignores comment lines such as :keepalive", () => {
      const block = ":keepalive\n\n";
      const result = parseSSEBlock(block);
      expect(result).toBeNull();
    });

    it("parses standard event and json data correctly", () => {
      const block = 'event: call_update\ndata: {"call_id":"c_123","status":"in_progress"}';
      const result = parseSSEBlock(block);
      expect(result).toEqual({
        event: "call_update",
        data: {
          call_id: "c_123",
          status: "in_progress",
        },
      });
    });

    it("parses connected event with plain string data", () => {
      const block = "event: connected\ndata: Connected to business_123 stream";
      const result = parseSSEBlock(block);
      expect(result).toEqual({
        event: "connected",
        data: "Connected to business_123 stream",
      });
    });

    it("concatenates multiline data entries", () => {
      const block = "event: log\ndata: line 1\ndata: line 2";
      const result = parseSSEBlock(block);
      expect(result).toEqual({
        event: "log",
        data: "line 1\nline 2",
      });
    });

    it("ignores comments mixed in with real data", () => {
      const block = ":heartbeat\nevent: call_ended\n:another comment\ndata: {\"call_id\":\"c_999\"}";
      const result = parseSSEBlock(block);
      expect(result).toEqual({
        event: "call_ended",
        data: {
          call_id: "c_999",
        },
      });
    });
  });

  describe("consumeEventStream", () => {
    it("reassembles fragmented chunks across byte boundaries", async () => {
      const encoder = new TextEncoder();
      const chunks = [
        encoder.encode("event: call_"),
        encoder.encode('update\ndata: {"call_id":"xyz"}\n\n'),
        encoder.encode(':keepalive\n\nevent: call_'),
        encoder.encode('ended\ndata: {"call_id":"xyz"}\n\n'),
      ];

      let chunkIndex = 0;
      const reader = {
        read: vi.fn(async () => {
          if (chunkIndex < chunks.length) {
            return { done: false, value: chunks[chunkIndex++] };
          }
          return { done: true, value: undefined };
        }),
      } as unknown as ReadableStreamDefaultReader<Uint8Array>;

      const received: LiveEvent[] = [];
      await consumeEventStream(reader, (event) => {
        received.push(event);
      });

      expect(received).toHaveLength(2);
      expect(received[0]).toEqual({
        event: "call_update",
        data: { call_id: "xyz" },
      });
      expect(received[1]).toEqual({
        event: "call_ended",
        data: { call_id: "xyz" },
      });
    });

    it("stops reading when abort signal is triggered", async () => {
      const encoder = new TextEncoder();
      const controller = new AbortController();

      const reader = {
        read: vi.fn(async () => {
          controller.abort();
          return {
            done: false,
            value: encoder.encode('event: test\ndata: {"ok":true}\n\n'),
          };
        }),
      } as unknown as ReadableStreamDefaultReader<Uint8Array>;

      const received: LiveEvent[] = [];
      await consumeEventStream(
        reader,
        (event) => {
          received.push(event);
        },
        controller.signal,
      );

      // Should have read one, then terminated on signal abort
      expect(received.length).toBeLessThanOrEqual(1);
    });
  });
});
