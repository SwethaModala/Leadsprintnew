import React, { useEffect, useRef, useState } from "react";
import {
  X,
  Radio,
  Loader2,
  AlertCircle,
  Bot,
  User,
  Wrench,
  CheckCircle2,
  Clock,
} from "lucide-react";
import type { ActiveCallDto } from "@workspace/api-client-react";
import { useAuthenticatedEventStream } from "../lib/useAuthenticatedEventStream";
import { ElapsedDuration } from "./ActiveCallsWidget";

export interface LiveTranscriptItem {
  id: string;
  role: "agent" | "user";
  content: string;
  timestamp?: string;
}

export interface LiveToolCallItem {
  id: string;
  toolName: string;
  status: string;
  result?: string;
  timestamp?: string;
}

interface LiveCallMonitorModalProps {
  call: ActiveCallDto;
  onClose: () => void;
}

export function LiveCallMonitorModal({ call, onClose }: LiveCallMonitorModalProps) {
  const [transcripts, setTranscripts] = useState<LiveTranscriptItem[]>([]);
  const [tools, setTools] = useState<LiveToolCallItem[]>([]);
  const [callEnded, setCallEnded] = useState(false);
  const [endedReason, setEndedReason] = useState<string | null>(null);
  const [transferState, setTransferState] = useState<string | null>(
    (call as any).transfer_state ?? null,
  );
  const [transferDestination, setTransferDestination] = useState<string | null>(
    (call as any).transfer_destination ?? null,
  );
  const scrollRef = useRef<HTMLDivElement>(null);

  const { isConnected, isConnecting, error } = useAuthenticatedEventStream({
    url: `/api/calls/${call.id}/monitor-stream`,
    enabled: Boolean(call.id) && !callEnded,
    onEvent: (event) => {
      if (event.event === "snapshot") {
        const snap = event.data;
        if (Array.isArray(snap?.transcripts)) {
          setTranscripts(
            snap.transcripts.map((t: any) => ({
              id: crypto.randomUUID(),
              role: t.role === "agent" ? "agent" : "user",
              content: t.content,
              timestamp: t.timestamp,
            })),
          );
        }
        if (Array.isArray(snap?.tools)) {
          setTools(
            snap.tools.map((item: any) => ({
              id: crypto.randomUUID(),
              toolName: item.toolName,
              status: item.status,
              result: item.result,
              timestamp: item.timestamp,
            })),
          );
        }
      } else if (event.event === "transcript") {
        const item = event.data;
        setTranscripts((prev) => {
          const last = prev[prev.length - 1];
          if (
            last &&
            last.role === item.role &&
            item.content &&
            typeof item.content === "string" &&
            item.content.startsWith(last.content)
          ) {
            return [...prev.slice(0, -1), { ...last, content: item.content }];
          }
          return [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: item.role === "agent" ? "agent" : "user",
              content: item.content,
              timestamp: item.timestamp,
            },
          ];
        });
      } else if (event.event === "tool_call") {
        setTools((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            toolName: event.data.toolName,
            status: event.data.status,
            result: event.data.result,
            timestamp: event.data.timestamp,
          },
        ]);
      } else if (event.event === "call_ended") {
        setCallEnded(true);
        setEndedReason(event.data?.reason || "Call completed");
      } else if (event.event === "transfer_update") {
        const data = event.data;
        if (data?.transferStatus) {
          setTransferState(data.transferStatus);
        }
        if (data?.destination) {
          setTransferDestination(data.destination);
        }
      }
    },
  });

  // Auto-scroll to bottom of conversation
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [transcripts, tools]);

  // Auto-close on call end after 4 seconds
  useEffect(() => {
    if (!callEnded) {
      return undefined;
    }
    const timer = setTimeout(() => {
      onClose();
    }, 4000);
    return () => clearTimeout(timer);
  }, [callEnded, onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      data-testid="live-monitor-modal"
    >
      <div className="relative w-full max-w-2xl rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] shadow-2xl flex flex-col max-h-[85vh] overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[hsl(var(--border))] px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-[hsl(var(--primary))/0.1] text-[hsl(var(--primary))]">
              <Radio size={20} className={isConnected && !callEnded ? "animate-pulse" : ""} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-semibold text-base text-[hsl(var(--foreground))]">
                  Live Call Monitor
                </h3>
                <span
                  className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${
                    callEnded
                      ? "bg-neutral-500/15 text-neutral-500"
                      : isConnected
                        ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                        : isConnecting
                          ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                          : "bg-rose-500/15 text-rose-600 dark:text-rose-400"
                  }`}
                  data-testid="monitor-status-badge"
                >
                  {isConnected && !callEnded && (
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-ping" />
                  )}
                  {callEnded
                    ? "Call Ended"
                    : isConnected
                      ? "Live Stream"
                      : isConnecting
                        ? "Connecting..."
                        : "Disconnected"}
                </span>
              </div>
              <p className="text-xs text-[hsl(var(--muted-foreground))]">
                {call.lead_name || "Direct Caller"} · {call.phone} · Agent:{" "}
                {call.agent_name || "Samantha Sales"}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1 text-xs text-[hsl(var(--muted-foreground))] font-mono">
              <Clock size={13} />
              <ElapsedDuration startedAt={call.started_at} />
            </div>
            <button
              onClick={onClose}
              className="p-1.5 rounded-md hover:bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] transition-colors"
              data-testid="button-close-monitor"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Transfer State Banner */}
        {transferState && (
          <div
            className={`border-b px-5 py-2.5 flex items-center justify-between text-xs font-medium ${
              transferState === "transfer_bridged"
                ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-600 dark:text-emerald-400"
                : transferState === "transfer_started"
                  ? "bg-sky-500/10 border-sky-500/20 text-sky-600 dark:text-sky-400 animate-pulse"
                  : transferState === "transfer_cancelled"
                    ? "bg-rose-500/10 border-rose-500/20 text-rose-600 dark:text-rose-400"
                    : "bg-neutral-500/10 border-neutral-500/20 text-neutral-600 dark:text-neutral-400"
            }`}
            data-testid="monitor-transfer-banner"
          >
            <div className="flex items-center gap-2">
              <span className="font-semibold">
                {transferState === "transfer_started"
                  ? "Transfer initiated (Waiting for human operator)"
                  : transferState === "transfer_bridged"
                    ? "Connected to human operator"
                    : transferState === "transfer_cancelled"
                      ? "Transfer unsuccessful"
                      : "Transfer ended"}
              </span>
            </div>
            {transferDestination && (
              <span className="font-mono text-[11px] opacity-80">
                Destination: {transferDestination}
              </span>
            )}
          </div>
        )}

        {/* Call Ended Alert Banner */}
        {callEnded && (
          <div
            className="bg-neutral-500/10 border-b border-neutral-500/20 px-5 py-2.5 flex items-center justify-between text-xs text-neutral-600 dark:text-neutral-400"
            data-testid="monitor-call-ended-banner"
          >
            <span className="flex items-center gap-1.5">
              <CheckCircle2 size={14} className="text-emerald-500" />
              Call has concluded ({endedReason || "Call completed"}). Window will close automatically.
            </span>
            <button
              onClick={onClose}
              className="font-semibold underline hover:no-underline"
            >
              Close now
            </button>
          </div>
        )}

        {/* Error Alert Banner */}
        {error && !callEnded && (
          <div
            className="bg-rose-500/10 border-b border-rose-500/20 px-5 py-2 flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400"
            data-testid="monitor-error-banner"
          >
            <AlertCircle size={14} />
            <span>Connection issue: {error.message}. Reconnecting...</span>
          </div>
        )}

        {/* Live Conversation Transcript Body */}
        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto p-5 space-y-4 min-h-[300px] max-h-[500px]"
          data-testid="monitor-transcript-container"
        >
          {transcripts.length === 0 && !callEnded && (
            <div className="flex flex-col items-center justify-center py-12 text-center text-xs text-[hsl(var(--muted-foreground))]">
              <Loader2 size={24} className="animate-spin text-[hsl(var(--primary))] mb-2" />
              <p className="font-medium text-sm text-[hsl(var(--foreground))]">
                Listening for speech...
              </p>
              <p>Transcript will appear here as the conversation unfolds.</p>
            </div>
          )}

          {transcripts.map((item) => {
            const isAgent = item.role === "agent";
            return (
              <div
                key={item.id}
                className={`flex gap-3 ${isAgent ? "justify-end" : "justify-start"}`}
                data-testid={`transcript-item-${item.role}`}
              >
                {!isAgent && (
                  <div className="flex-shrink-0 h-7 w-7 rounded-full bg-blue-500/15 text-blue-600 flex items-center justify-center">
                    <User size={14} />
                  </div>
                )}

                <div
                  className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-xs ${
                    isAgent
                      ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] rounded-tr-sm"
                      : "bg-[hsl(var(--muted))] text-[hsl(var(--foreground))] rounded-tl-sm border border-[hsl(var(--border))/0.5]"
                  }`}
                >
                  <p className="font-semibold text-[10px] opacity-75 mb-0.5">
                    {isAgent ? call.agent_name || "Samantha Sales (AI)" : call.lead_name || "Caller"}
                  </p>
                  <p className="leading-relaxed whitespace-pre-wrap">{item.content}</p>
                </div>

                {isAgent && (
                  <div className="flex-shrink-0 h-7 w-7 rounded-full bg-[hsl(var(--primary))/0.15] text-[hsl(var(--primary))] flex items-center justify-center">
                    <Bot size={14} />
                  </div>
                )}
              </div>
            );
          })}

          {/* Tool Calls Display */}
          {tools.map((tool) => (
            <div
              key={tool.id}
              className="flex items-center gap-2 p-2.5 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--muted))/0.4] text-xs text-[hsl(var(--muted-foreground))]"
              data-testid="tool-call-item"
            >
              <Wrench size={13} className="text-amber-500" />
              <span className="font-mono font-medium text-[hsl(var(--foreground))]">
                {tool.toolName}
              </span>
              <span className="px-1.5 py-0.5 rounded text-[10px] bg-amber-500/10 text-amber-600 font-semibold uppercase">
                {tool.status}
              </span>
              {tool.result && (
                <span className="truncate text-[11px] text-[hsl(var(--muted-foreground))]">
                  → {tool.result}
                </span>
              )}
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="border-t border-[hsl(var(--border))] px-5 py-3 flex items-center justify-between bg-[hsl(var(--muted))/0.2]">
          <span className="text-[11px] text-[hsl(var(--muted-foreground))]">
            Live speech transcription via Retell monitor broker.
          </span>
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs font-semibold rounded-md border border-[hsl(var(--border))] hover:bg-[hsl(var(--muted))] text-[hsl(var(--foreground))] transition-colors"
            data-testid="button-footer-close"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
