import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TenantEventBus } from "./eventBus";
import type { Request, Response } from "express";

function createMockSocket() {
  const req = new EventEmitter() as unknown as Request;
  const res = new EventEmitter() as unknown as Response & {
    written: string[];
    headers: Record<string, string>;
    writableEnded: boolean;
  };

  res.written = [];
  res.headers = {};
  res.writableEnded = false;

  res.setHeader = (name: string, value: string) => {
    res.headers[name.toLowerCase()] = value;
    return res;
  };
  res.flushHeaders = vi.fn();
  res.write = (chunk: string) => {
    if (res.writableEnded) throw new Error("Write after end");
    res.written.push(chunk);
    return true;
  };
  res.end = () => {
    res.writableEnded = true;
    res.emit("close");
    return res;
  };

  return { req, res };
}

describe("TenantEventBus", () => {
  let bus: TenantEventBus;

  beforeEach(() => {
    bus = new TenantEventBus(100); // 100ms heartbeats for tests
  });

  afterEach(() => {
    bus.reset();
  });

  it("registers an SSE client with standard headers and greeting event", () => {
    const { req, res } = createMockSocket();
    const { clientId, cleanup } = bus.registerClient({
      businessId: "biz_tenant_1",
      userId: "user_1",
      req,
      res,
    });

    expect(clientId).toMatch(/^sse_/);
    expect(res.headers["content-type"]).toBe("text/event-stream");
    expect(res.headers["cache-control"]).toBe("no-cache, no-transform");
    expect(res.headers["connection"]).toBe("keep-alive");
    expect(res.headers["x-accel-buffering"]).toBe("no");

    // First message should be connected event
    expect(res.written.length).toBeGreaterThanOrEqual(1);
    expect(res.written[0]).toContain("event: connected\ndata: {");
    expect(res.written[0]).toContain('"businessId":"biz_tenant_1"');

    expect(bus.getClientCount("biz_tenant_1")).toBe(1);
    cleanup();
    expect(bus.getClientCount("biz_tenant_1")).toBe(0);
  });

  it("strictly isolates broadcasts by tenant", () => {
    const socketA = createMockSocket();
    const socketB = createMockSocket();

    bus.registerClient({
      businessId: "tenant_alpha",
      userId: "user_a",
      req: socketA.req,
      res: socketA.res,
    });

    bus.registerClient({
      businessId: "tenant_beta",
      userId: "user_b",
      req: socketB.req,
      res: socketB.res,
    });

    // Clear initial greeting
    socketA.res.written = [];
    socketB.res.written = [];

    // Broadcast to tenant_alpha only
    const delivered = bus.broadcast("tenant_alpha", "call_update", {
      id: "call_123",
      status: "in_progress",
    });

    expect(delivered).toBe(1);

    // Socket A must have received the update
    expect(socketA.res.written.length).toBe(1);
    expect(socketA.res.written[0]).toContain("event: call_update\ndata: {");
    expect(socketA.res.written[0]).toContain('"id":"call_123"');

    // Socket B must have received NOTHING
    expect(socketB.res.written.length).toBe(0);
  });

  it("delivers broadcast to multiple clients within the same tenant", () => {
    const s1 = createMockSocket();
    const s2 = createMockSocket();

    bus.registerClient({ businessId: "tenant_shared", userId: "u1", req: s1.req, res: s1.res });
    bus.registerClient({ businessId: "tenant_shared", userId: "u2", req: s2.req, res: s2.res });

    s1.res.written = [];
    s2.res.written = [];

    const delivered = bus.broadcast("tenant_shared", "call_update", {
      id: "call_abc",
      status: "completed",
    });

    expect(delivered).toBe(2);
    expect(s1.res.written[0]).toContain('"id":"call_abc"');
    expect(s2.res.written[0]).toContain('"id":"call_abc"');
  });

  it("cleans up connection when client terminates request", () => {
    const { req, res } = createMockSocket();
    bus.registerClient({
      businessId: "tenant_drop",
      userId: "u_drop",
      req,
      res,
    });

    expect(bus.getClientCount("tenant_drop")).toBe(1);

    // Simulate browser closing tab
    req.emit("close");

    expect(bus.getClientCount("tenant_drop")).toBe(0);
    expect(bus.getTotalClientCount()).toBe(0);
  });

  it("sends periodic keepalive comment pings", async () => {
    vi.useFakeTimers();
    const fastBus = new TenantEventBus(50);
    const { req, res } = createMockSocket();

    fastBus.registerClient({
      businessId: "tenant_ping",
      userId: "u_ping",
      req,
      res,
    });

    res.written = [];

    // Advance timers by 120ms (should trigger at least 2 heartbeats)
    vi.advanceTimersByTime(120);

    const heartbeats = res.written.filter((chunk) => chunk === ":keepalive\n\n");
    expect(heartbeats.length).toBeGreaterThanOrEqual(2);

    fastBus.reset();
    vi.useRealTimers();
  });

  it("drops slow clients when buffer backpressure threshold is exceeded", () => {
    const { req, res } = createMockSocket();
    // Simulate backpressure by making write return false
    res.write = () => false;

    bus.registerClient({
      businessId: "tenant_slow",
      userId: "u_slow",
      req,
      res,
    });

    expect(bus.getClientCount("tenant_slow")).toBe(1);

    // Send 55 events to exceed backpressure limit (50)
    for (let i = 0; i < 55; i += 1) {
      bus.broadcast("tenant_slow", "call_update", { id: `call_${i}` });
    }

    // Client should have been disconnected
    expect(bus.getClientCount("tenant_slow")).toBe(0);
    expect(res.writableEnded).toBe(true);
  });
});
