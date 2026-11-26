import { useEffect, useRef, useState, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getAuthToken,
  getBaseUrl,
  getGetActiveCallsQueryKey,
  getGetTodayQueryKey,
} from "@workspace/api-client-react";

export interface LiveEvent {
  event: string;
  data: any;
}

export interface UseAuthenticatedEventStreamOptions {
  enabled?: boolean;
  url?: string;
  getToken?: () => Promise<string | null>;
  onEvent?: (event: LiveEvent) => void;
  onConnected?: () => void;
  onError?: (error: Error) => void;
  maxReconnectDelayMs?: number;
}

export interface UseAuthenticatedEventStreamResult {
  isConnected: boolean;
  isConnecting: boolean;
  lastEvent: LiveEvent | null;
  error: Error | null;
  reconnect: () => void;
}

export function parseSSEBlock(block: string): LiveEvent | null {
  const lines = block.split(/\r?\n/);
  let eventType = "message";
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith(":")) {
      // Comment line (e.g. :keepalive ping), ignore
      continue;
    }
    if (line.startsWith("event:")) {
      eventType = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
  }

  if (dataLines.length === 0 && eventType === "message") {
    return null;
  }

  const rawData = dataLines.join("\n");
  let parsedData: any = rawData;
  try {
    parsedData = JSON.parse(rawData);
  } catch {
    // Keep raw string if not JSON
  }

  return { event: eventType, data: parsedData };
}

export async function consumeEventStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onMessage: (event: LiveEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    if (signal?.aborted) break;
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      const parsed = parseSSEBlock(part);
      if (parsed) {
        onMessage(parsed);
      }
    }
  }
}

export function useAuthenticatedEventStream(
  options: UseAuthenticatedEventStreamOptions = {},
): UseAuthenticatedEventStreamResult {
  const {
    enabled = true,
    url = "/api/events/live",
    getToken = getAuthToken,
    onEvent,
    onConnected,
    onError,
    maxReconnectDelayMs = 16_000,
  } = options;

  const queryClient = useQueryClient();
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [lastEvent, setLastEvent] = useState<LiveEvent | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const isUnmountedRef = useRef(false);

  // Keep callback refs fresh
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;

  const invalidateCallQueries = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: getGetActiveCallsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetTodayQueryKey() });
    queryClient.invalidateQueries({
      predicate: (query) => {
        const key = query.queryKey[0];
        return typeof key === "string" && key.includes("/calls");
      },
    });
  }, [queryClient]);

  const connect = useCallback(() => {
    if (isUnmountedRef.current || !enabled) return;

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;
    setIsConnecting(true);

    (async () => {
      try {
        let endpoint = url;
        const baseUrl = getBaseUrl();
        if (baseUrl && endpoint.startsWith("/")) {
          endpoint = `${baseUrl}${endpoint}`;
        }

        const token = await getTokenRef.current();
        const headers: Record<string, string> = {
          Accept: "text/event-stream",
        };
        if (token) {
          headers["Authorization"] = `Bearer ${token}`;
        }

        const response = await fetch(endpoint, {
          headers,
          signal: controller.signal,
          credentials: "include",
        });

        if (response.status === 401 || response.status === 403) {
          const authErr = new Error(`Unauthorized SSE access: ${response.status}`);
          setError(authErr);
          setIsConnected(false);
          setIsConnecting(false);
          onErrorRef.current?.(authErr);
          // Do not reconnect automatically on permanent auth rejection
          return;
        }

        if (!response.ok) {
          throw new Error(`SSE HTTP error: ${response.status} ${response.statusText}`);
        }

        if (!response.body) {
          throw new Error("SSE response has no readable body");
        }

        setIsConnected(true);
        setIsConnecting(false);
        setError(null);
        reconnectAttemptsRef.current = 0;

        // Invalidate queries on connection/reconnection to ensure freshness
        invalidateCallQueries();
        onConnectedRef.current?.();

        const reader = response.body.getReader();

        await consumeEventStream(
          reader,
          (parsed) => {
            setLastEvent(parsed);
            onEventRef.current?.(parsed);

            // If call event, invalidate active calls cache immediately
            if (
              parsed.event === "call_update" ||
              parsed.event === "call_started" ||
              parsed.event === "call_ended"
            ) {
              invalidateCallQueries();
            } else if (parsed.event === "connected") {
              onConnectedRef.current?.();
            }
          },
          controller.signal,
        );
      } catch (err: any) {
        if (controller.signal.aborted) {
          return; // Expected abort during teardown or reconnect
        }

        const streamErr = err instanceof Error ? err : new Error(String(err));
        setError(streamErr);
        setIsConnected(false);
        setIsConnecting(false);
        onErrorRef.current?.(streamErr);

        // Schedule reconnect with exponential backoff + jitter
        if (!isUnmountedRef.current && enabled) {
          const attempts = reconnectAttemptsRef.current;
          const delay = Math.min(
            1000 * Math.pow(2, attempts) + Math.random() * 500,
            maxReconnectDelayMs,
          );
          reconnectAttemptsRef.current += 1;
          reconnectTimeoutRef.current = setTimeout(() => {
            connect();
          }, delay);
        }
      }
    })();
  }, [enabled, url, maxReconnectDelayMs, invalidateCallQueries]);

  useEffect(() => {
    isUnmountedRef.current = false;
    if (enabled) {
      connect();
    } else {
      setIsConnected(false);
      setIsConnecting(false);
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    }

    return () => {
      isUnmountedRef.current = true;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      setIsConnected(false);
      setIsConnecting(false);
    };
  }, [enabled, connect]);

  const reconnect = useCallback(() => {
    reconnectAttemptsRef.current = 0;
    connect();
  }, [connect]);

  return {
    isConnected,
    isConnecting,
    lastEvent,
    error,
    reconnect,
  };
}
