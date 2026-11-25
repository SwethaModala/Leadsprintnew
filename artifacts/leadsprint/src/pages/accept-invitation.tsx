import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, AlertTriangle, Loader2, ShieldCheck } from "lucide-react";
import { Link } from "wouter";
import { useAcceptTeamInvitation } from "@workspace/api-client-react";
import { Button } from "@/components/common";

export const PENDING_INVITE_STORAGE_KEY = "ls_pending_invite_token";

function readInviteTokenFromBrowser(): string {
  if (typeof window === "undefined") return "";
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const hashToken = hashParams.get("token")?.trim();
  if (hashToken) {
    try {
      sessionStorage.setItem(PENDING_INVITE_STORAGE_KEY, hashToken);
    } catch {
      // Ignore storage access errors.
    }
    return hashToken;
  }
  try {
    return sessionStorage.getItem(PENDING_INVITE_STORAGE_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

function clearStoredInviteToken(): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(PENDING_INVITE_STORAGE_KEY);
  } catch {
    // Ignore storage access errors.
  }
  if (window.location.hash) {
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }
}

function getErrorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const data = (error as { data?: { error?: string } }).data;
    if (data?.error) return data.error;
    if ("message" in error && typeof (error as { message?: unknown }).message === "string") {
      return (error as { message: string }).message;
    }
  }
  return "Unable to accept this invitation.";
}

export default function AcceptInvitationPage() {
  const queryClient = useQueryClient();
  const acceptMutation = useAcceptTeamInvitation();
  const [token, setToken] = useState("");
  const [acceptedOrgName, setAcceptedOrgName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setToken(readInviteTokenFromBrowser());
  }, []);

  const handleAccept = async () => {
    const candidate = token || readInviteTokenFromBrowser();
    if (!candidate) {
      setError("Invitation token is missing or invalid.");
      return;
    }
    setError(null);
    try {
      const result = await acceptMutation.mutateAsync({ data: { token: candidate } });
      clearStoredInviteToken();
      await queryClient.resetQueries();
      setAcceptedOrgName(result.organization.name);
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-[hsl(var(--background))] px-4">
      <div className="w-full max-w-md rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-8 shadow-sm">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[hsl(var(--primary))/0.12] text-[hsl(var(--primary))]">
          <ShieldCheck size={20} />
        </div>
        <h1 className="mt-4 text-xl font-bold text-[hsl(var(--foreground))]">
          Workspace invitation
        </h1>

        {acceptedOrgName ? (
          <div className="mt-4 space-y-4">
            <div
              className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs font-medium text-emerald-800"
              role="status"
            >
              <CheckCircle2 size={15} className="mt-0.5 shrink-0" />
              <span>
                You joined <strong>{acceptedOrgName}</strong>. Your active workspace has been switched.
              </span>
            </div>
            <Link
              href="/workspace"
              className="inline-flex w-full items-center justify-center rounded-lg bg-[hsl(var(--primary))] px-4 py-2.5 text-xs font-bold text-[hsl(var(--primary-foreground))]"
            >
              Open workspace
            </Link>
          </div>
        ) : (
          <div className="mt-3 space-y-4">
            <p className="text-xs leading-relaxed text-[hsl(var(--muted-foreground))]">
              Accept this invitation to join the organization with your signed-in LeadSprint account.
            </p>
            {error && (
              <div
                className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-xs font-medium text-red-700"
                role="alert"
              >
                <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}
            <div className="flex gap-2">
              <Button
                variant="primary"
                className="flex-1"
                disabled={acceptMutation.isPending || !token}
                onClick={() => void handleAccept()}
                data-testid="button-accept-invitation"
              >
                {acceptMutation.isPending && <Loader2 size={13} className="animate-spin" />}
                {acceptMutation.isPending ? "Joining…" : "Accept invitation"}
              </Button>
              <Link
                href="/workspace"
                className="inline-flex items-center justify-center rounded-lg border border-[hsl(var(--border))] px-3 py-2 text-xs font-semibold text-[hsl(var(--foreground))]"
              >
                Cancel
              </Link>
            </div>
            {!token && (
              <p className="text-[11px] text-[hsl(var(--muted-foreground))]">
                No invitation token was found in this link. Open the invitation link directly from your email.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

