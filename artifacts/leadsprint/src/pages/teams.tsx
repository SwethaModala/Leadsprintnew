import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  Clock,
  Loader2,
  Mail,
  Plus,
  Shield,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import {
  getGetAuditLogsQueryKey,
  getGetTeamQueryKey,
  useGetAuditLogs,
  useGetTeam,
  useInviteTeamMember,
  useRemoveTeamMember,
  useRevokeTeamInvitation,
  useUpdateTeamMemberRole,
  type OrgRole,
  type TeamMember,
} from "@workspace/api-client-react";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Skeleton,
  initials,
} from "@/components/common";

const ROLE_DESCRIPTION: Record<OrgRole, string> = {
  owner: "Full workspace control, billing, team roles, and organization administration",
  admin: "Invite and manage managers or members, edit workspace settings, and operate leads/calls",
  manager: "Manage leads, trigger outbound calls, suppress contacts, and book appointments",
  member: "Read-only access to workspace dashboard, leads, calls, appointments, and reports",
};

const ROLE_BADGE_CLASS: Record<OrgRole, string> = {
  owner: "border-[hsl(var(--primary))/0.3] bg-[hsl(var(--primary))/0.1] text-[hsl(var(--primary))]",
  admin: "border-amber-200 bg-amber-50 text-amber-800",
  manager: "border-emerald-200 bg-emerald-50 text-emerald-800",
  member: "border-[hsl(var(--border))] bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]",
};

function getErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === "object") {
    const data = (error as { data?: { error?: string } }).data;
    if (data?.error) return data.error;
    if ("message" in error && typeof (error as { message?: unknown }).message === "string") {
      return (error as { message: string }).message;
    }
  }
  return fallback;
}

function canActorManageMember(
  actorRole: OrgRole,
  actorUserId: string,
  member: TeamMember,
): boolean {
  if (member.user_id === actorUserId) return false;
  if (actorRole === "owner") return true;
  if (actorRole === "admin") {
    return member.role === "manager" || member.role === "member";
  }
  return false;
}

function editableRolesForActor(actorRole: OrgRole): OrgRole[] {
  if (actorRole === "owner") return ["owner", "admin", "manager", "member"];
  if (actorRole === "admin") return ["manager", "member"];
  return [];
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "Never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function TeamsPage() {
  const queryClient = useQueryClient();
  const teamQuery = useGetTeam();
  const canInspectAdminData = Boolean(
    teamQuery.data?.permissions.can_manage_roles,
  );
  const auditLogsQuery = useGetAuditLogs(
    { limit: 25 },
    {
      query: {
        queryKey: getGetAuditLogsQueryKey({ limit: 25 }),
        enabled: canInspectAdminData,
      },
    },
  );

  const inviteMember = useInviteTeamMember();
  const revokeInvite = useRevokeTeamInvitation();
  const updateRole = useUpdateTeamMemberRole();
  const removeMember = useRemoveTeamMember();

  const [showInviteModal, setShowInviteModal] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<OrgRole>("member");
  const [feedback, setFeedback] = useState<{ tone: "success" | "error"; text: string } | null>(
    null,
  );

  const refreshTeam = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: getGetTeamQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getGetAuditLogsQueryKey({ limit: 25 }) }),
    ]);
  };

  if (teamQuery.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (teamQuery.isError || !teamQuery.data) {
    return <ErrorState retry={() => void teamQuery.refetch()} />;
  }

  const { organization, current_user_id, current_role, permissions, members, invitations } =
    teamQuery.data;
  const pendingInvitations = invitations.filter((inv) => inv.status === "pending");
  const assignableRoles = editableRolesForActor(current_role);
  const ownerCount = members.filter((m) => m.role === "owner").length;

  const openInviteModal = () => {
    const defaultRole = permissions.allowed_invite_roles[permissions.allowed_invite_roles.length - 1] ?? "member";
    setInviteRole(defaultRole);
    setInviteEmail("");
    setShowInviteModal(true);
    setFeedback(null);
  };

  const handleInvite = async (e: FormEvent) => {
    e.preventDefault();
    setFeedback(null);
    try {
      const result = await inviteMember.mutateAsync({
        data: {
          email: inviteEmail.trim(),
          role: inviteRole,
        },
      });
      setShowInviteModal(false);
      setInviteEmail("");
      const statusMsg =
        result.delivery_status === "sent"
          ? `Invitation emailed to ${result.invitation.email}.`
          : result.delivery_status === "demo_logged"
            ? `Invitation created for ${result.invitation.email} (demo mode — SMTP not configured).`
            : `Invitation recorded for ${result.invitation.email} (SMTP is not configured on this dev server).`;
      setFeedback({ tone: "success", text: statusMsg });
      await refreshTeam();
    } catch (err) {
      setFeedback({ tone: "error", text: getErrorMessage(err, "Unable to send invitation") });
    }
  };

  const handleRevoke = async (invitationId: string) => {
    setFeedback(null);
    try {
      await revokeInvite.mutateAsync({ invitationId });
      setFeedback({ tone: "success", text: "Invitation revoked." });
      await refreshTeam();
    } catch (err) {
      setFeedback({ tone: "error", text: getErrorMessage(err, "Unable to revoke invitation") });
    }
  };

  const handleRoleChange = async (membershipId: string, nextRole: OrgRole) => {
    setFeedback(null);
    try {
      await updateRole.mutateAsync({ membershipId, data: { role: nextRole } });
      setFeedback({ tone: "success", text: "Member role updated." });
      await refreshTeam();
    } catch (err) {
      setFeedback({ tone: "error", text: getErrorMessage(err, "Unable to update member role") });
    }
  };

  const handleRemove = async (member: TeamMember) => {
    setFeedback(null);
    try {
      await removeMember.mutateAsync({ membershipId: member.membership_id });
      setFeedback({ tone: "success", text: `${member.name} was removed from ${organization.name}.` });
      await refreshTeam();
    } catch (err) {
      setFeedback({ tone: "error", text: getErrorMessage(err, "Unable to remove member") });
    }
  };

  return (
    <div className="space-y-6" data-testid="teams-page">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-bold text-[hsl(var(--foreground))]">
              {organization.name}
            </h2>
            <Badge className={`${ROLE_BADGE_CLASS[current_role]} capitalize`}>
              Your role: {current_role}
            </Badge>
          </div>
          <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">
            {members.length} active {members.length === 1 ? "member" : "members"} ·{" "}
            {pendingInvitations.length} pending{" "}
            {pendingInvitations.length === 1 ? "invitation" : "invitations"}
          </p>
        </div>

        {permissions.can_invite && (
          <Button
            variant="primary"
            onClick={openInviteModal}
            data-testid="button-invite-member"
          >
            <Plus size={14} />
            Invite member
          </Button>
        )}
      </div>

      {feedback && (
        <div
          role="status"
          data-testid="team-feedback-banner"
          className={`flex items-center gap-2 rounded-xl border px-4 py-3 text-xs font-medium ${
            feedback.tone === "success"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-red-200 bg-red-50 text-red-700"
          }`}
        >
          <CheckCircle2 size={14} className="shrink-0" />
          <span>{feedback.text}</span>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {(["owner", "admin", "manager", "member"] as OrgRole[]).map((role) => {
          const count = members.filter((m) => m.role === role).length;
          return (
            <Card key={role} className="p-4">
              <div className="flex items-center justify-between">
                <Badge className={`${ROLE_BADGE_CLASS[role]} capitalize`}>
                  {role}
                </Badge>
                <span className="text-lg font-bold tabular-nums text-[hsl(var(--foreground))]">
                  {count}
                </span>
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-[hsl(var(--muted-foreground))]">
                {ROLE_DESCRIPTION[role]}
              </p>
            </Card>
          );
        })}
      </div>

      <Card className="overflow-hidden">
        <div className="border-b border-[hsl(var(--border))] px-5 py-3.5">
          <div className="flex items-center gap-2 text-xs font-semibold text-[hsl(var(--foreground))]">
            <Users size={15} />
            <span>Organization members</span>
          </div>
        </div>

        {members.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No members found"
            description="Members belonging to this workspace will appear here."
          />
        ) : (
          <div className="divide-y divide-[hsl(var(--border))]">
            {members.map((member) => {
              const isSelf = member.user_id === current_user_id;
              const isLastOwner = member.role === "owner" && ownerCount <= 1;
              const canManage = canActorManageMember(current_role, current_user_id, member);

              return (
                <div
                  key={member.membership_id}
                  data-testid={`team-member-${member.user_id}`}
                  className="flex flex-wrap items-center justify-between gap-4 px-5 py-3.5"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[hsl(var(--primary))/0.12] text-xs font-bold text-[hsl(var(--primary))]">
                      {initials(member.name)}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-xs font-semibold text-[hsl(var(--foreground))]">
                          {member.name}
                        </span>
                        {isSelf && (
                          <Badge className="border-[hsl(var(--border))] bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]">
                            You
                          </Badge>
                        )}
                      </div>
                      <div className="truncate text-[11px] text-[hsl(var(--muted-foreground))]">
                        {member.email} · Joined {formatDate(member.joined_at)} · Last active{" "}
                        {formatDate(member.last_login_at)}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2.5">
                    {canManage ? (
                      <select
                        value={member.role}
                        disabled={updateRole.isPending || isLastOwner}
                        onChange={(e) =>
                          void handleRoleChange(member.membership_id, e.target.value as OrgRole)
                        }
                        data-testid={`select-role-${member.user_id}`}
                        aria-label={`Role for ${member.name}`}
                        className="rounded-lg border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-2.5 py-1.5 text-xs font-medium capitalize outline-none focus:border-[hsl(var(--primary))] disabled:opacity-60"
                      >
                        {assignableRoles.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <Badge className={`${ROLE_BADGE_CLASS[member.role]} capitalize`}>
                        {member.role}
                      </Badge>
                    )}

                    {canManage && !isLastOwner && (
                      <Button
                        size="sm"
                        disabled={removeMember.isPending}
                        onClick={() => void handleRemove(member)}
                        data-testid={`button-remove-${member.user_id}`}
                        className="text-[hsl(var(--destructive))] hover:bg-red-50"
                      >
                        <Trash2 size={13} />
                        Remove
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {permissions.can_invite && (
        <Card className="overflow-hidden">
          <div className="border-b border-[hsl(var(--border))] px-5 py-3.5">
            <div className="flex items-center gap-2 text-xs font-semibold text-[hsl(var(--foreground))]">
              <Mail size={15} />
              <span>Invitations</span>
            </div>
          </div>

          {invitations.length === 0 ? (
            <EmptyState
              icon={UserPlus}
              title="No invitations sent"
              description="Invite teammates with scoped owner, admin, manager, or member permissions."
            />
          ) : (
            <div className="divide-y divide-[hsl(var(--border))]">
              {invitations.map((inv) => (
                <div
                  key={inv.id}
                  data-testid={`team-invitation-${inv.id}`}
                  className="flex flex-wrap items-center justify-between gap-4 px-5 py-3"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-[hsl(var(--foreground))]">
                        {inv.email}
                      </span>
                      <Badge className={`${ROLE_BADGE_CLASS[inv.role]} capitalize`}>
                        {inv.role}
                      </Badge>
                      <Badge
                        className={`${
                          inv.status === "pending"
                            ? "border-amber-200 bg-amber-50 text-amber-800"
                            : inv.status === "accepted"
                              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                              : "border-[hsl(var(--border))] bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]"
                        } capitalize`}
                      >
                        {inv.status}
                      </Badge>
                    </div>
                    <div className="mt-0.5 text-[11px] text-[hsl(var(--muted-foreground))]">
                      Invited by {inv.invited_by_name ?? inv.invited_by_user_id} · Expires{" "}
                      {formatDateTime(inv.expires_at)}
                    </div>
                  </div>

                  {inv.status === "pending" &&
                    (current_role === "owner" || inv.role === "manager" || inv.role === "member") && (
                      <Button
                        size="sm"
                        disabled={revokeInvite.isPending}
                        onClick={() => void handleRevoke(inv.id)}
                        data-testid={`button-revoke-${inv.id}`}
                      >
                        Revoke
                      </Button>
                    )}
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {canInspectAdminData && (
        <Card className="overflow-hidden">
          <div className="border-b border-[hsl(var(--border))] px-5 py-3.5">
            <div className="flex items-center gap-2 text-xs font-semibold text-[hsl(var(--foreground))]">
              <ShieldCheck size={15} />
              <span>Workspace audit log</span>
            </div>
          </div>

          {auditLogsQuery.isLoading ? (
            <div className="p-5">
              <Skeleton className="h-24 w-full" />
            </div>
          ) : (auditLogsQuery.data?.logs ?? []).length === 0 ? (
            <EmptyState
              icon={Clock}
              title="No audit events recorded yet"
              description="Workspace creation, switching, invitations, and role changes appear here."
            />
          ) : (
            <div className="divide-y divide-[hsl(var(--border))]">
              {auditLogsQuery.data!.logs.map((entry) => (
                <div
                  key={entry.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-xs"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[11px] font-semibold text-[hsl(var(--foreground))]">
                        {entry.action}
                      </span>
                      <span className="text-[11px] text-[hsl(var(--muted-foreground))]">
                        by {entry.actor_name ?? entry.actor_email ?? entry.user_id ?? "system"}
                      </span>
                    </div>
                    {entry.details && (
                      <div className="mt-0.5 font-mono text-[11px] text-[hsl(var(--muted-foreground))]">
                        {JSON.stringify(entry.details)}
                      </div>
                    )}
                  </div>
                  <span className="text-[11px] text-[hsl(var(--muted-foreground))]">
                    {formatDateTime(entry.created_at)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {showInviteModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
          data-testid="modal-invite-member"
        >
          <div className="w-full max-w-md rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-6 shadow-xl">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Shield size={16} className="text-[hsl(var(--primary))]" />
                <h3 className="text-sm font-bold text-[hsl(var(--foreground))]">
                  Invite teammate to {organization.name}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowInviteModal(false)}
                className="text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]"
              >
                <X size={16} />
              </button>
            </div>

            <form onSubmit={(e) => void handleInvite(e)} className="mt-4 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-[hsl(var(--foreground))]">
                  Work email
                </label>
                <input
                  type="email"
                  required
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="teammate@company.com"
                  data-testid="input-invite-email"
                  className="mt-1.5 w-full rounded-lg border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-3 py-2 text-xs outline-none focus:border-[hsl(var(--primary))]"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-[hsl(var(--foreground))]">
                  Workspace role
                </label>
                <select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as OrgRole)}
                  data-testid="select-invite-role"
                  className="mt-1.5 w-full rounded-lg border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-3 py-2 text-xs capitalize outline-none focus:border-[hsl(var(--primary))]"
                >
                  {permissions.allowed_invite_roles.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
                <p className="mt-1.5 text-[11px] text-[hsl(var(--muted-foreground))]">
                  {ROLE_DESCRIPTION[inviteRole]}
                </p>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" onClick={() => setShowInviteModal(false)}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={inviteMember.isPending}
                  data-testid="button-submit-invite"
                >
                  {inviteMember.isPending && <Loader2 size={13} className="animate-spin" />}
                  {inviteMember.isPending ? "Sending…" : "Send invitation"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export default TeamsPage;
