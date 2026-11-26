/**
 * In-Memory Multi-Tenant Event Bus for Real-Time Server-Sent Events (SSE).
 *
 * Scoped to single-process deployment architecture (Coolify: Replicas: 1).
 * Isolates event streams strictly by tenant businessId.
 */

import type { Request, Response } from "express";
import crypto from "node:crypto";
import { logger } from "./logger";

export interface SSEClient {
  id: string;
  businessId: string;
  userId: string;
  req: Request;
  res: Response;
  heartbeatTimer?: NodeJS.Timeout;
  bufferedCount: number;
  drainPending?: boolean;
}

export interface SanitizedCallEventData {
  id: string;
  status: string;
  direction?: "inbound" | "outbound";
  lead_id?: string | null;
  lead_name?: string | null;
  phone?: string | null;
  agent_id?: string | null;
  agent_name?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  duration_seconds?: number | null;
  outcome?: string | null;
  error_state?: string | null;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 25_000;
const MAX_BUFFERED_MESSAGES_BEFORE_DROP = 50;

export class TenantEventBus {
  private tenants = new Map<string, Map<string, SSEClient>>();
  private heartbeatIntervalMs: number;

  constructor(heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS) {
    this.heartbeatIntervalMs = heartbeatIntervalMs;
  }

  /**
   * Subscribes an authenticated Express response to the tenant's real-time stream.
   * Configures SSE response headers, sets up heartbeat ping, and attaches cleanup listeners.
   */
  registerClient(options: {
    businessId: string;
    userId: string;
    req: Request;
    res: Response;
  }): { clientId: string; cleanup: () => void } {
    const { businessId, userId, req, res } = options;
    const clientId = `sse_${crypto.randomUUID().slice(0, 12)}`;

    // Set standard SSE response headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // Disable proxy buffering (Nginx / Traefik)
    res.flushHeaders?.();

    const client: SSEClient = {
      id: clientId,
      businessId,
      userId,
      req,
      res,
      bufferedCount: 0,
    };

    let tenantClients = this.tenants.get(businessId);
    if (!tenantClients) {
      tenantClients = new Map<string, SSEClient>();
      this.tenants.set(businessId, tenantClients);
    }
    tenantClients.set(clientId, client);

    // Initial greeting event acknowledging successful connection
    this.sendEventToClient(client, "connected", {
      clientId,
      businessId,
      timestamp: new Date().toISOString(),
    });

    // Start periodic keep-alive heartbeat
    client.heartbeatTimer = setInterval(() => {
      this.sendKeepalive(client);
    }, this.heartbeatIntervalMs);

    // Cleanup hook
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      if (client.heartbeatTimer) {
        clearInterval(client.heartbeatTimer);
        client.heartbeatTimer = undefined;
      }
      const currentTenantClients = this.tenants.get(businessId);
      if (currentTenantClients) {
        currentTenantClients.delete(clientId);
        if (currentTenantClients.size === 0) {
          this.tenants.delete(businessId);
        }
      }
      try {
        if (!res.writableEnded) {
          res.end();
        }
      } catch {
        // Socket already closed
      }
    };

    // Attach disconnection listeners on both request and response
    req.on("close", cleanup);
    res.on("close", cleanup);
    res.on("error", (err) => {
      logger.warn({ clientId, businessId, err }, "SSE client response error");
      cleanup();
    });

    return { clientId, cleanup };
  }

  /**
   * Broadcasts an event to all connected clients belonging to the specified tenant.
   * Completely isolated: never sends data to any other tenant.
   */
  broadcast(businessId: string, event: string, data: SanitizedCallEventData | Record<string, unknown>): number {
    const tenantClients = this.tenants.get(businessId);
    if (!tenantClients || tenantClients.size === 0) {
      return 0;
    }

    let sentCount = 0;
    for (const client of tenantClients.values()) {
      const ok = this.sendEventToClient(client, event, data);
      if (ok) {
        sentCount += 1;
      }
    }
    return sentCount;
  }

  /**
   * Formats and writes an SSE message frame to a single client socket.
   * Enforces backpressure protection against slow consumers.
   */
  private sendEventToClient(client: SSEClient, event: string, data: unknown): boolean {
    if (client.res.writableEnded) {
      this.disconnectClient(client);
      return false;
    }

    try {
      const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      const ok = client.res.write(payload);
      if (!ok) {
        client.bufferedCount += 1;
        if (client.bufferedCount > MAX_BUFFERED_MESSAGES_BEFORE_DROP) {
          logger.warn(
            { clientId: client.id, businessId: client.businessId },
            "Dropping slow SSE client due to excessive buffer backpressure",
          );
          this.disconnectClient(client);
          return false;
        }
        if (!client.drainPending) {
          client.drainPending = true;
          client.res.once("drain", () => {
            client.bufferedCount = 0;
            client.drainPending = false;
          });
        }
      } else {
        client.bufferedCount = 0;
      }
      return true;
    } catch {
      this.disconnectClient(client);
      return false;
    }
  }

  /**
   * Sends an SSE comment heartbeat to maintain the TCP connection through proxies.
   */
  private sendKeepalive(client: SSEClient): void {
    if (client.res.writableEnded) {
      this.disconnectClient(client);
      return;
    }
    try {
      client.res.write(":keepalive\n\n");
    } catch {
      this.disconnectClient(client);
    }
  }

  /**
   * Forcefully removes and tears down a client socket.
   */
  private disconnectClient(client: SSEClient): void {
    if (client.heartbeatTimer) {
      clearInterval(client.heartbeatTimer);
      client.heartbeatTimer = undefined;
    }
    const tenantClients = this.tenants.get(client.businessId);
    if (tenantClients) {
      tenantClients.delete(client.id);
      if (tenantClients.size === 0) {
        this.tenants.delete(client.businessId);
      }
    }
    try {
      if (!client.res.writableEnded) {
        client.res.end();
      }
    } catch {
      // Ignored
    }
  }

  /**
   * Returns active connection count for a specific tenant.
   */
  getClientCount(businessId: string): number {
    return this.tenants.get(businessId)?.size ?? 0;
  }

  /**
   * Total number of active SSE connections across all tenants.
   */
  getTotalClientCount(): number {
    let count = 0;
    for (const tenant of this.tenants.values()) {
      count += tenant.size;
    }
    return count;
  }

  /**
   * Clears all connections and timers (primarily for test teardown).
   */
  reset(): void {
    for (const tenant of this.tenants.values()) {
      for (const client of tenant.values()) {
        if (client.heartbeatTimer) {
          clearInterval(client.heartbeatTimer);
        }
        try {
          if (!client.res.writableEnded) {
            client.res.end();
          }
        } catch {
          // Ignored
        }
      }
    }
    this.tenants.clear();
  }
}

export const tenantEventBus = new TenantEventBus();
