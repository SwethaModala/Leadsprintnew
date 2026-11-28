import React, { useEffect, useState } from "react";
import {
  PhoneCall,
  PhoneIncoming,
  PhoneOutgoing,
  Bot,
  Clock,
  Radio,
  Loader2,
  AlertCircle,
} from "lucide-react";
import {
  useGetActiveCalls,
  useStopCall,
  useCancelQueuedCall,
  useReconcileCall,
  type ActiveCallDto,
} from "@workspace/api-client-react";
import { useAuthenticatedEventStream } from "../lib/useAuthenticatedEventStream";
import { Badge, Button, Skeleton } from "./common";
import { LiveCallMonitorModal } from "./LiveCallMonitorModal";

export function formatElapsed(seconds: number): string {
  if (Number.isNaN(seconds) || seconds < 0) return "00:00";
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

export function parseElapsedSeconds(startedAt?: string | null): number | null {
  if (!startedAt) return null;
  const time = new Date(startedAt).getTime();
  if (Number.isNaN(time)) return null;
  const diff = Math.floor((Date.now() - time) / 1000);
  return Math.max(0, diff);
}

export function ElapsedDuration({ startedAt }: { startedAt?: string | null }) {
  const [elapsed, setElapsed] = useState<number>(() => {
    return parseElapsedSeconds(startedAt) ?? 0;
  });

  const isValidDate = startedAt != null && !Number.isNaN(new Date(startedAt).getTime());

  useEffect(() => {
    if (!isValidDate) {
      setElapsed(0);
      return;
    }

    const interval = setInterval(() => {
      const parsed = parseElapsedSeconds(startedAt);
      setElapsed(parsed ?? 0);
    }, 1000);

    return () => clearInterval(interval);
  }, [startedAt, isValidDate]);

  if (!isValidDate) {
    return <span className="text-[hsl(var(--muted-foreground))]">Queued</span>;
  }

  return (
    <span className="font-mono text-sm font-semibold tracking-wider text-[hsl(var(--foreground))]">
      {formatElapsed(elapsed)}
    </span>
  );
}

export interface ActiveCallsWidgetProps {
  compact?: boolean;
  className?: string;
  onSelectCall?: (callId: string) => void;
}

export function ActiveCallsWidget({
  compact = false,
  className = "",
  onSelectCall,
}: ActiveCallsWidgetProps) {
  const [monitoringCall, setMonitoringCall] = useState<ActiveCallDto | null>(null);
  const { data: activeCalls = [], isLoading, isError, refetch } = useGetActiveCalls();
  const { isConnected, isConnecting } = useAuthenticatedEventStream();

  if (isLoading) {
    return (
      <div
        className={`rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-5 shadow-xs ${className}`}
        data-testid="active-calls-widget-loading"
      >
        <div className="flex items-center justify-between pb-3">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-20" />
        </div>
        <div className="space-y-3 pt-2">
          <Skeleton className="h-16 w-full rounded-lg" />
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div
        className={`rounded-xl border border-[hsl(var(--destructive))/0.3] bg-[hsl(var(--destructive))/0.05] p-4 ${className}`}
        data-testid="active-calls-widget-error"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-[hsl(var(--destructive))]">
            <AlertCircle size={16} />
            <span>Unable to load live calls</span>
          </div>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  const callCount = activeCalls.length;

  return (
    <section
      className={`rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] shadow-xs transition-all ${className}`}
      data-testid="active-calls-widget"
    >
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[hsl(var(--border))] px-5 py-3.5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[hsl(var(--primary))/0.1] text-[hsl(var(--primary))]">
            <Radio size={16} className={callCount > 0 ? "animate-pulse" : ""} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-[hsl(var(--card-foreground))]">
                Live &amp; Active Calls
              </h3>
              {callCount > 0 ? (
                <span
                  className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-semibold text-emerald-600 dark:text-emerald-400"
                  data-testid="badge-active-call-count"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-ping" />
                  {callCount} active
                </span>
              ) : (
                <span className="rounded-full bg-[hsl(var(--muted))] px-2 py-0.5 text-[11px] font-medium text-[hsl(var(--muted-foreground))]">
                  Idle
                </span>
              )}
            </div>
            {!compact && (
              <p className="text-xs text-[hsl(var(--muted-foreground))]">
                Real-time active voice conversations and queue status
              </p>
            )}
          </div>
        </div>

        {/* Live SSE status indicator */}
        <div className="flex items-center gap-2 text-xs" data-testid="stream-status-indicator">
          {isConnected ? (
            <span className="inline-flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400 font-medium">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
              </span>
              Live Stream
            </span>
          ) : isConnecting ? (
            <span className="inline-flex items-center gap-1.5 text-amber-500 font-medium">
              <Loader2 size={12} className="animate-spin" />
              Connecting…
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-[hsl(var(--muted-foreground))] font-medium">
              <span className="h-2 w-2 rounded-full bg-zinc-400"></span>
              Stream Standby
            </span>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="p-4 sm:p-5">
        {callCount === 0 ? (
          <div
            className="flex flex-col items-center justify-center py-6 text-center text-sm"
            data-testid="empty-active-calls"
          >
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))] mb-2.5">
              <PhoneCall size={20} />
            </div>
            <p className="font-medium text-[hsl(var(--card-foreground))]">
              No calls currently active
            </p>
            <p className="text-xs text-[hsl(var(--muted-foreground))] max-w-sm mt-1">
              Active outbound calls and incoming conversations will automatically stream here with live elapsed duration.
            </p>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
            {activeCalls.map((call) => (
              <ActiveCallCard
                key={call.id}
                call={call}
                onSelect={() => onSelectCall?.(call.id)}
                onMonitor={() => setMonitoringCall(call)}
              />
            ))}
          </div>
        )}
      </div>

      {monitoringCall && (
        <LiveCallMonitorModal
          call={monitoringCall}
          onClose={() => setMonitoringCall(null)}
        />
      )}
    </section>
  );
}

function ActiveCallCard({
  call,
  onSelect,
  onMonitor,
}: {
  call: ActiveCallDto;
  onSelect: () => void;
  onMonitor?: () => void;
}) {
  const isInProgress = call.status === "in_progress";
  const isUncertain = call.status === "uncertain";
  const isQueued = call.status === "queued";
  const isInbound = call.direction === "inbound";
  const isStopPending = Boolean(call.stop_pending);
  const isStopAmbiguous = Boolean(call.stop_ambiguous);

  const stopCallMutation = useStopCall();
  const cancelCallMutation = useCancelQueuedCall();
  const reconcileCallMutation = useReconcileCall();

  const handleStop = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isQueued) {
      await cancelCallMutation.mutateAsync({ id: call.id });
    } else {
      await stopCallMutation.mutateAsync({ id: call.id, data: { force_retry: false } });
    }
  };

  const handleForceStop = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await stopCallMutation.mutateAsync({ id: call.id, data: { force_retry: true } });
  };

  const handleReconcile = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await reconcileCallMutation.mutateAsync({ id: call.id });
  };

  const isActionLoading =
    stopCallMutation.isPending || cancelCallMutation.isPending || reconcileCallMutation.isPending;

  return (
    <div
      className="group relative flex flex-col justify-between rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] p-4 transition-all hover:border-[hsl(var(--primary))/0.4] hover:shadow-xs"
      data-testid={`active-call-card-${call.id}`}
    >
      <div>
        {/* Top bar: Status & Direction */}
        <div className="flex items-center justify-between gap-2 pb-3 border-b border-[hsl(var(--border))/0.6]">
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${
                isStopPending
                  ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                  : isStopAmbiguous
                    ? "bg-rose-500/15 text-rose-600 dark:text-rose-400"
                    : isUncertain
                      ? "bg-purple-500/15 text-purple-600 dark:text-purple-400"
                      : isInProgress
                        ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                        : "bg-amber-500/15 text-amber-600 dark:text-amber-400"
              }`}
              data-testid={`badge-call-status-${call.id}`}
            >
              {isInProgress && !isStopPending && !isStopAmbiguous && (
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
              )}
              {isStopPending
                ? "Stopping..."
                : isStopAmbiguous
                  ? "Ending Pending (Ambiguous)"
                  : isUncertain
                    ? "Uncertain"
                    : isInProgress
                      ? "In Progress"
                      : "Queued"}
            </span>

            <span className="inline-flex items-center gap-1 rounded-md bg-[hsl(var(--muted))] px-1.5 py-0.5 text-[11px] font-medium text-[hsl(var(--muted-foreground))]">
              {isInbound ? (
                <>
                  <PhoneIncoming size={11} className="text-blue-500" /> Inbound
                </>
              ) : (
                <>
                  <PhoneOutgoing size={11} className="text-violet-500" /> Outbound
                </>
              )}
            </span>
          </div>

          {/* Live timer */}
          <div className="flex items-center gap-1 text-xs">
            <Clock size={12} className="text-[hsl(var(--muted-foreground))]" />
            <ElapsedDuration startedAt={call.started_at} />
          </div>
        </div>

        {/* Lead & Phone info */}
        <div className="pt-3 pb-2 space-y-1">
          <p className="font-semibold text-sm text-[hsl(var(--foreground))] line-clamp-1">
            {call.lead_name || "Direct Caller"}
          </p>
          <p className="text-xs text-[hsl(var(--muted-foreground))] font-mono">
            {isInbound
              ? `From: ${call.caller_number || "Unknown"}`
              : `To: ${call.destination_number || call.caller_number || "—"}`}
          </p>
        </div>

        {/* AI Agent */}
        <div className="flex items-center gap-1.5 pt-1 text-xs text-[hsl(var(--muted-foreground))]">
          <Bot size={13} className="text-[hsl(var(--primary))]" />
          <span className="truncate">Agent: {call.agent_name || "Samantha Sales"}</span>
        </div>
      </div>

      {/* Action / Detail footer */}
      <div className="pt-3 mt-2 border-t border-[hsl(var(--border))/0.6] flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {isQueued && (
            <button
              onClick={handleStop}
              disabled={isActionLoading}
              className="px-2 py-1 text-xs font-medium rounded-md bg-rose-500/10 text-rose-600 hover:bg-rose-500/20 disabled:opacity-50"
              data-testid={`button-cancel-call-${call.id}`}
            >
              Cancel Call
            </button>
          )}

          {isInProgress && !isStopPending && !isStopAmbiguous && (
            <div className="flex items-center gap-1.5">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onMonitor?.();
                }}
                className="px-2 py-1 text-xs font-medium rounded-md bg-sky-500/10 text-sky-600 hover:bg-sky-500/20"
                data-testid={`button-monitor-call-${call.id}`}
              >
                Monitor
              </button>
              <button
                onClick={handleStop}
                disabled={isActionLoading}
                className="px-2 py-1 text-xs font-medium rounded-md bg-rose-500/10 text-rose-600 hover:bg-rose-500/20 disabled:opacity-50"
                data-testid={`button-stop-call-${call.id}`}
              >
                End Call
              </button>
            </div>
          )}

          {isStopPending && (
            <span className="text-xs text-[hsl(var(--muted-foreground))] italic">
              Termination pending...
            </span>
          )}

          {isStopAmbiguous && (
            <div className="flex items-center gap-1">
              <button
                onClick={handleReconcile}
                disabled={isActionLoading}
                className="px-2 py-1 text-xs font-medium rounded-md bg-amber-500/15 text-amber-600 hover:bg-amber-500/25 disabled:opacity-50"
                data-testid={`button-reconcile-call-${call.id}`}
              >
                Reconcile
              </button>
              <button
                onClick={handleForceStop}
                disabled={isActionLoading}
                className="px-2 py-1 text-xs font-medium rounded-md bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-50"
                data-testid={`button-force-stop-call-${call.id}`}
              >
                Force Stop
              </button>
            </div>
          )}

          {isUncertain && !isStopAmbiguous && (
            <button
              onClick={handleReconcile}
              disabled={isActionLoading}
              className="px-2 py-1 text-xs font-medium rounded-md bg-purple-500/15 text-purple-600 hover:bg-purple-500/25 disabled:opacity-50"
              data-testid={`button-reconcile-call-${call.id}`}
            >
              Reconcile State
            </button>
          )}
        </div>

        <button
          onClick={onSelect}
          className="text-xs font-semibold text-[hsl(var(--primary))] hover:underline flex items-center gap-1"
          data-testid={`button-view-active-call-${call.id}`}
        >
          View details →
        </button>
      </div>
    </div>
  );
}
