import type { Response } from "express";
import crypto from "node:crypto";
import { logger } from "./logger";

export interface SanitizedTranscriptEvent {
  role: "agent" | "user";
  content: string;
  timestamp: string;
}

export interface SanitizedToolCallEvent {
  toolName: string;
  status: string;
  result?: string;
  timestamp: string;
}

export interface MonitorSubscriber {
  id: string;
  userId: string;
  res: Response;
  pingTimer?: NodeJS.Timeout;
}

export interface ActiveMonitorSession {
  callId: string;
  businessId: string;
  providerCallId: string;
  ws: WebSocket | null;
  subscribers: Map<string, MonitorSubscriber>;
  transcriptHistory: SanitizedTranscriptEvent[];
  toolHistory: SanitizedToolCallEvent[];
  status: "connecting" | "live" | "ended" | "error";
  reconnectAttempts: number;
}

export type WebSocketFactory = (
  url: string,
  options?: { headers?: Record<string, string> },
) => WebSocket;

let activeWsFactory: WebSocketFactory = (url, options) => {
  return new WebSocket(url, options as any);
};

export function __setWebSocketFactory(factory: WebSocketFactory): void {
  activeWsFactory = factory;
}

export function __resetWebSocketFactory(): void {
  activeWsFactory = (url, options) => new WebSocket(url, options as any);
}

const MAX_TRANSCRIPT_HISTORY = 100;
const MAX_TOOL_HISTORY = 30;
const MAX_CONCURRENT_SESSIONS_PER_TENANT = 10;
const MAX_SUBSCRIBERS_PER_CALL = 5;
const KEEPALIVE_INTERVAL_MS = 15_000;

export class CallMonitorManager {
  private sessions = new Map<string, ActiveMonitorSession>();

  /**
   * Returns the count of active monitoring sessions for a given tenant.
   */
  getTenantSessionCount(businessId: string): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.businessId === businessId && session.status !== "ended") {
        count += 1;
      }
    }
    return count;
  }

  /**
   * Subscribes an authenticated operator response stream to a live call monitor.
   * Reuses existing upstream WebSocket if already established.
   */
  subscribe(options: {
    callId: string;
    businessId: string;
    providerCallId: string;
    apiKey: string;
    userId: string;
    res: Response;
  }): { subscriberId: string; cleanup: () => void } {
    const { callId, businessId, providerCallId, apiKey, userId, res } = options;

    let session = this.sessions.get(callId);

    if (session) {
      if (session.businessId !== businessId) {
        throw new Error("Cross-tenant monitor access denied");
      }
      if (session.subscribers.size >= MAX_SUBSCRIBERS_PER_CALL) {
        throw new Error("Maximum concurrent subscribers reached for this call");
      }
    } else {
      if (this.getTenantSessionCount(businessId) >= MAX_CONCURRENT_SESSIONS_PER_TENANT) {
        throw new Error("Maximum concurrent monitoring sessions reached for tenant");
      }

      session = {
        callId,
        businessId,
        providerCallId,
        ws: null,
        subscribers: new Map(),
        transcriptHistory: [],
        toolHistory: [],
        status: "connecting",
        reconnectAttempts: 0,
      };
      this.sessions.set(callId, session);
      this.connectUpstream(session, apiKey);
    }

    const subscriberId = `sub_${crypto.randomUUID().slice(0, 10)}`;
    const subscriber: MonitorSubscriber = {
      id: subscriberId,
      userId,
      res,
    };

    session.subscribers.set(subscriberId, subscriber);

    // Initial greeting and catch-up snapshot
    this.sendSSE(res, "connected", {
      callId,
      providerCallId,
      status: session.status,
    });

    if (session.transcriptHistory.length > 0 || session.toolHistory.length > 0) {
      this.sendSSE(res, "snapshot", {
        transcripts: session.transcriptHistory,
        tools: session.toolHistory,
      });
    }

    // Keepalive heartbeats
    subscriber.pingTimer = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) {
        res.write(": keepalive\n\n");
      }
    }, KEEPALIVE_INTERVAL_MS);

    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      if (subscriber.pingTimer) {
        clearInterval(subscriber.pingTimer);
      }
      session?.subscribers.delete(subscriberId);

      // If no subscribers remain, teardown the upstream WebSocket
      if (session && session.subscribers.size === 0) {
        this.teardownSession(callId);
      }
    };

    return { subscriberId, cleanup };
  }

  private connectUpstream(session: ActiveMonitorSession, apiKey: string): void {
    const wsUrl = `wss://api.retellai.com/v2/monitor-call/${session.providerCallId}`;

    try {
      const ws = activeWsFactory(wsUrl, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });

      session.ws = ws;

      ws.onopen = () => {
        session.status = "live";
        session.reconnectAttempts = 0;
        this.broadcast(session, "status", { status: "live" });
      };

      ws.onmessage = (event: MessageEvent) => {
        try {
          const rawText = typeof event.data === "string" ? event.data : event.data?.toString?.();
          if (!rawText) return;

          const parsed = JSON.parse(rawText);
          this.handleUpstreamEvent(session, parsed);
        } catch (parseErr) {
          logger.warn({ err: parseErr, callId: session.callId }, "Failed to parse monitor event");
        }
      };

      ws.onerror = (err) => {
        logger.warn({ err, callId: session.callId }, "Monitor upstream WebSocket error");
        session.status = "error";
        this.broadcast(session, "error", { message: "Upstream provider stream error" });
      };

      ws.onclose = () => {
        if (session.status !== "ended") {
          session.status = "ended";
          this.broadcast(session, "call_ended", { reason: "Call ended or disconnected" });
        }
        this.teardownSession(session.callId);
      };
    } catch (err) {
      logger.error({ err, callId: session.callId }, "Failed to initiate upstream monitor WebSocket");
      session.status = "error";
      this.broadcast(session, "error", { message: "Failed to connect to provider" });
      this.teardownSession(session.callId);
    }
  }

  private handleUpstreamEvent(session: ActiveMonitorSession, payload: Record<string, unknown>): void {
    const eventType = payload.event_type || payload.type || payload.event;

    // 1. Transcript Turns
    if (
      eventType === "transcript_update" ||
      eventType === "transcript" ||
      typeof payload.content === "string" ||
      typeof payload.transcript === "string"
    ) {
      const role = payload.role === "agent" ? "agent" : "user";
      const rawContent = payload.content ?? payload.transcript;
      const content = typeof rawContent === "string" ? rawContent.trim() : "";

      if (content.length > 0) {
        const item: SanitizedTranscriptEvent = {
          role,
          content,
          timestamp: new Date().toISOString(),
        };

        // Deduplicate or append if new turn
        const last = session.transcriptHistory[session.transcriptHistory.length - 1];
        if (last && last.role === role && content.startsWith(last.content)) {
          last.content = content; // In-flight token expansion
        } else {
          session.transcriptHistory.push(item);
          if (session.transcriptHistory.length > MAX_TRANSCRIPT_HISTORY) {
            session.transcriptHistory.shift();
          }
        }

        this.broadcast(session, "transcript", item);
      }
    }

    // 2. Tool Calls
    if (eventType === "tool_call" || payload.tool_name || payload.toolName) {
      const toolName = String(payload.tool_name || payload.toolName || "tool");
      const status = String(payload.status || "executing");
      const resultStr = payload.result != null ? String(payload.result).slice(0, 300) : undefined;

      const toolItem: SanitizedToolCallEvent = {
        toolName,
        status,
        result: resultStr,
        timestamp: new Date().toISOString(),
      };

      session.toolHistory.push(toolItem);
      if (session.toolHistory.length > MAX_TOOL_HISTORY) {
        session.toolHistory.shift();
      }

      this.broadcast(session, "tool_call", toolItem);
    }

    // 3. Node Transitions
    if (eventType === "node_transition" || payload.destination_node || payload.node_name) {
      const nodeName = String(payload.destination_node || payload.node_name || "transition");
      this.broadcast(session, "node_transition", {
        nodeName,
        timestamp: new Date().toISOString(),
      });
    }

    // 4. Call Ended
    if (eventType === "call_ended" || payload.call_status === "ended") {
      session.status = "ended";
      const reason = String(payload.disconnection_reason || "Call completed");
      this.broadcast(session, "call_ended", { reason });
      this.teardownSession(session.callId);
    }
  }

  /**
   * Broadcasts a transfer state update to any live monitoring subscribers for a call.
   */
  notifyTransferEvent(options: {
    callId: string;
    businessId: string;
    transferStatus: "transfer_started" | "transfer_bridged" | "transfer_cancelled" | "transfer_ended";
    destination?: string;
    reason?: string;
  }): void {
    const session = this.sessions.get(options.callId);
    if (!session || session.businessId !== options.businessId) return;

    this.broadcast(session, "transfer_update", {
      transferStatus: options.transferStatus,
      destination: options.destination,
      reason: options.reason,
      timestamp: new Date().toISOString(),
    });
  }

  private broadcast(session: ActiveMonitorSession, event: string, data: unknown): void {
    for (const sub of session.subscribers.values()) {
      this.sendSSE(sub.res, event, data);
    }
  }

  private sendSSE(res: Response, event: string, data: unknown): void {
    if (res.writableEnded || res.destroyed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private teardownSession(callId: string): void {
    const session = this.sessions.get(callId);
    if (!session) return;

    if (session.ws) {
      try {
        session.ws.onopen = null;
        session.ws.onmessage = null;
        session.ws.onerror = null;
        session.ws.onclose = null;
        session.ws.close();
      } catch {
        // Ignored
      }
      session.ws = null;
    }

    for (const sub of session.subscribers.values()) {
      if (sub.pingTimer) clearInterval(sub.pingTimer);
      if (!sub.res.writableEnded && !sub.res.destroyed) {
        sub.res.end();
      }
    }
    session.subscribers.clear();

    this.sessions.delete(callId);
  }

  /**
   * Resets all sessions (used for test teardown).
   */
  reset(): void {
    for (const callId of [...this.sessions.keys()]) {
      this.teardownSession(callId);
    }
    this.sessions.clear();
  }

  getSessionCount(): number {
    return this.sessions.size;
  }
}

export const callMonitorManager = new CallMonitorManager();
