import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  CallMonitorManager,
  __setWebSocketFactory,
  __resetWebSocketFactory,
  type WebSocketFactory,
} from "./callMonitor";
import type { Response } from "express";

class MockWebSocket {
  url: string;
  options?: { headers?: Record<string, string> };
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((err: any) => void) | null = null;
  onclose: (() => void) | null = null;
  readyState = 0; // CONNECTING
  closed = false;

  constructor(url: string, options?: { headers?: Record<string, string> }) {
    this.url = url;
    this.options = options;
  }

  simulateOpen(): void {
    this.readyState = 1; // OPEN
    this.onopen?.();
  }

  simulateMessage(data: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  simulateError(err: any): void {
    this.onerror?.(err);
  }

  simulateClose(): void {
    this.readyState = 3; // CLOSED
    this.closed = true;
    this.onclose?.();
  }

  close(): void {
    this.readyState = 3;
    this.closed = true;
  }
}

function createMockResponse(): Response & { written: string[]; ended: boolean } {
  const written: string[] = [];
  let ended = false;
  return {
    written,
    get ended() {
      return ended;
    },
    writableEnded: false,
    destroyed: false,
    write: vi.fn((chunk: string) => {
      written.push(chunk);
      return true;
    }),
    end: vi.fn(() => {
      ended = true;
      return true;
    }),
  } as unknown as Response & { written: string[]; ended: boolean };
}

describe("CallMonitorManager", () => {
  let manager: CallMonitorManager;
  let activeSockets: MockWebSocket[] = [];

  beforeEach(() => {
    manager = new CallMonitorManager();
    activeSockets = [];
    const factory: WebSocketFactory = (url, options) => {
      const ws = new MockWebSocket(url, options);
      activeSockets.push(ws);
      return ws as unknown as WebSocket;
    };
    __setWebSocketFactory(factory);
  });

  afterEach(() => {
    manager.reset();
    __resetWebSocketFactory();
  });

  it("creates upstream WebSocket with Retell monitor URL and Bearer authorization header", () => {
    const res = createMockResponse();
    manager.subscribe({
      callId: "call_1",
      businessId: "biz_1",
      providerCallId: "retell_call_1",
      apiKey: "secret_retell_key",
      userId: "user_1",
      res,
    });

    expect(activeSockets).toHaveLength(1);
    expect(activeSockets[0].url).toBe("wss://api.retellai.com/v2/monitor-call/retell_call_1");
    expect(activeSockets[0].options?.headers?.Authorization).toBe("Bearer secret_retell_key");

    // Initial connected SSE event is sent
    expect(res.write).toHaveBeenCalledWith(
      expect.stringContaining('event: connected\ndata: {"callId":"call_1","providerCallId":"retell_call_1","status":"connecting"}'),
    );
  });

  it("multiplexes multiple subscribers onto a single upstream WebSocket", () => {
    const res1 = createMockResponse();
    const res2 = createMockResponse();

    const sub1 = manager.subscribe({
      callId: "call_1",
      businessId: "biz_1",
      providerCallId: "retell_call_1",
      apiKey: "key_1",
      userId: "user_1",
      res: res1,
    });

    const sub2 = manager.subscribe({
      callId: "call_1",
      businessId: "biz_1",
      providerCallId: "retell_call_1",
      apiKey: "key_1",
      userId: "user_2",
      res: res2,
    });

    expect(activeSockets).toHaveLength(1);
    expect(sub1.subscriberId).not.toBe(sub2.subscriberId);

    // Simulate upstream open
    activeSockets[0].simulateOpen();

    // Both subscribers should receive status update
    expect(res1.written.some((w) => w.includes('event: status\ndata: {"status":"live"}'))).toBe(true);
    expect(res2.written.some((w) => w.includes('event: status\ndata: {"status":"live"}'))).toBe(true);
  });

  it("replays snapshot history to new subscribers who join an active call", () => {
    const res1 = createMockResponse();
    manager.subscribe({
      callId: "call_1",
      businessId: "biz_1",
      providerCallId: "retell_call_1",
      apiKey: "key_1",
      userId: "user_1",
      res: res1,
    });

    const ws = activeSockets[0];
    ws.simulateOpen();

    // Emit transcript and tool events
    ws.simulateMessage({
      event_type: "transcript_update",
      role: "agent",
      content: "Hello, I am calling from LeadSprint.",
    });

    ws.simulateMessage({
      event_type: "tool_call",
      tool_name: "check_availability",
      status: "completed",
      result: "Slots available at 2 PM",
    });

    // Subscriber 2 joins late
    const res2 = createMockResponse();
    manager.subscribe({
      callId: "call_1",
      businessId: "biz_1",
      providerCallId: "retell_call_1",
      apiKey: "key_1",
      userId: "user_2",
      res: res2,
    });

    const snapshotCall = res2.written.find((w) => w.includes("event: snapshot"));
    expect(snapshotCall).toBeDefined();
    expect(snapshotCall).toContain("Hello, I am calling from LeadSprint.");
    expect(snapshotCall).toContain("check_availability");
  });

  it("sanitizes transcript updates, merging partial updates for the same speaker", () => {
    const res = createMockResponse();
    manager.subscribe({
      callId: "call_1",
      businessId: "biz_1",
      providerCallId: "retell_call_1",
      apiKey: "key_1",
      userId: "user_1",
      res,
    });

    const ws = activeSockets[0];
    ws.simulateOpen();

    ws.simulateMessage({
      event_type: "transcript_update",
      role: "user",
      content: "I want to",
    });

    ws.simulateMessage({
      event_type: "transcript_update",
      role: "user",
      content: "I want to buy a house",
    });

    const transcriptEvents = res.written
      .filter((w) => w.includes("event: transcript"))
      .map((w) => JSON.parse(w.replace(/^event: transcript\ndata: /, "").trim()));

    expect(transcriptEvents).toHaveLength(2);
    expect(transcriptEvents[0].content).toBe("I want to");
    expect(transcriptEvents[1].content).toBe("I want to buy a house");
    expect(transcriptEvents[0].role).toBe("user");
  });

  it("sanitizes tool calls and limits result length", () => {
    const res = createMockResponse();
    manager.subscribe({
      callId: "call_1",
      businessId: "biz_1",
      providerCallId: "retell_call_1",
      apiKey: "key_1",
      userId: "user_1",
      res,
    });

    const ws = activeSockets[0];
    ws.simulateOpen();

    const hugeResult = "x".repeat(500);
    ws.simulateMessage({
      event_type: "tool_call",
      tool_name: "book_appointment",
      status: "success",
      result: hugeResult,
    });

    const toolEvents = res.written
      .filter((w) => w.includes("event: tool_call"))
      .map((w) => JSON.parse(w.replace(/^event: tool_call\ndata: /, "").trim()));

    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0].toolName).toBe("book_appointment");
    expect(toolEvents[0].status).toBe("success");
    expect(toolEvents[0].result?.length).toBe(300);
  });

  it("tears down upstream WebSocket and removes session when all subscribers disconnect", () => {
    const res1 = createMockResponse();
    const res2 = createMockResponse();

    const sub1 = manager.subscribe({
      callId: "call_1",
      businessId: "biz_1",
      providerCallId: "retell_call_1",
      apiKey: "key_1",
      userId: "user_1",
      res: res1,
    });

    const sub2 = manager.subscribe({
      callId: "call_1",
      businessId: "biz_1",
      providerCallId: "retell_call_1",
      apiKey: "key_1",
      userId: "user_2",
      res: res2,
    });

    expect(manager.getSessionCount()).toBe(1);
    const ws = activeSockets[0];
    expect(ws.closed).toBe(false);

    // Subscriber 1 disconnects
    sub1.cleanup();
    expect(manager.getSessionCount()).toBe(1);
    expect(ws.closed).toBe(false);

    // Subscriber 2 disconnects -> teardown
    sub2.cleanup();
    expect(manager.getSessionCount()).toBe(0);
    expect(ws.closed).toBe(true);
  });

  it("broadcasts call_ended and closes session when upstream call ends", () => {
    const res = createMockResponse();
    manager.subscribe({
      callId: "call_1",
      businessId: "biz_1",
      providerCallId: "retell_call_1",
      apiKey: "key_1",
      userId: "user_1",
      res,
    });

    const ws = activeSockets[0];
    ws.simulateOpen();

    ws.simulateMessage({
      event_type: "call_ended",
      disconnection_reason: "user_hangup",
    });

    expect(res.written.some((w) => w.includes('event: call_ended\ndata: {"reason":"user_hangup"}'))).toBe(true);
    expect(manager.getSessionCount()).toBe(0);
    expect(res.ended).toBe(true);
  });

  it("enforces tenant boundaries, rejecting cross-tenant subscription to existing session", () => {
    const res1 = createMockResponse();
    manager.subscribe({
      callId: "call_1",
      businessId: "biz_A",
      providerCallId: "retell_call_1",
      apiKey: "key_1",
      userId: "user_1",
      res: res1,
    });

    const res2 = createMockResponse();
    expect(() => {
      manager.subscribe({
        callId: "call_1",
        businessId: "biz_B", // Different tenant!
        providerCallId: "retell_call_1",
        apiKey: "key_2",
        userId: "user_2",
        res: res2,
      });
    }).toThrow("Cross-tenant monitor access denied");
  });

  it("enforces maximum subscriber limit per call (5 max)", () => {
    for (let i = 0; i < 5; i++) {
      const res = createMockResponse();
      manager.subscribe({
        callId: "call_limit",
        businessId: "biz_1",
        providerCallId: "retell_1",
        apiKey: "key_1",
        userId: `user_${i}`,
        res,
      });
    }

    const overflowRes = createMockResponse();
    expect(() => {
      manager.subscribe({
        callId: "call_limit",
        businessId: "biz_1",
        providerCallId: "retell_1",
        apiKey: "key_1",
        userId: "user_6",
        res: overflowRes,
      });
    }).toThrow("Maximum concurrent subscribers reached for this call");
  });

  it("enforces tenant concurrent session limit (10 max)", () => {
    for (let i = 0; i < 10; i++) {
      const res = createMockResponse();
      manager.subscribe({
        callId: `call_${i}`,
        businessId: "biz_limit",
        providerCallId: `retell_${i}`,
        apiKey: "key_1",
        userId: `user_1`,
        res,
      });
    }

    const overflowRes = createMockResponse();
    expect(() => {
      manager.subscribe({
        callId: "call_11",
        businessId: "biz_limit",
        providerCallId: "retell_11",
        apiKey: "key_1",
        userId: "user_1",
        res: overflowRes,
      });
    }).toThrow("Maximum concurrent monitoring sessions reached for tenant");
  });
});
