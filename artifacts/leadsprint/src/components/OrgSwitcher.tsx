import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Building2, Check, ChevronDown, Loader2, Plus, X } from "lucide-react";
import {
  useCreateOrganization,
  useListOrganizations,
  useSwitchOrganization,
  type OrganizationSummary,
} from "@workspace/api-client-react";
import { Badge, Button } from "@/components/common";

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

export function OrgSwitcher() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useListOrganizations();
  const switchOrg = useSwitchOrganization();
  const createOrg = useCreateOrganization();

  const [menuOpen, setMenuOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [orgName, setOrgName] = useState("");
  const [vertical, setVertical] = useState<"real_estate" | "home_services">("real_estate");
  const [market, setMarket] = useState<"US" | "IN">("US");
  const [error, setError] = useState<string | null>(null);

  const organizations: OrganizationSummary[] = data?.organizations ?? [];
  const activeOrg =
    organizations.find((o) => o.is_active) ??
    organizations.find((o) => o.id === data?.active_business_id) ??
    organizations[0];

  const handleSwitch = async (businessId: string) => {
    if (!businessId || businessId === activeOrg?.id) {
      setMenuOpen(false);
      return;
    }
    setError(null);
    try {
      await switchOrg.mutateAsync({ data: { business_id: businessId } });
      setMenuOpen(false);
      await queryClient.resetQueries();
    } catch (err) {
      setError(getErrorMessage(err, "Unable to switch workspace"));
    }
  };

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (orgName.trim().length < 2) return;
    setError(null);
    try {
      await createOrg.mutateAsync({
        data: {
          name: orgName.trim(),
          vertical,
          market,
        },
      });
      setOrgName("");
      setCreateOpen(false);
      setMenuOpen(false);
      await queryClient.resetQueries();
    } catch (err) {
      setError(getErrorMessage(err, "Unable to create workspace"));
    }
  };

  if (isLoading || !activeOrg) {
    return (
      <div className="mt-4 px-1">
        <div className="h-10 animate-pulse rounded-lg bg-[hsl(var(--muted))]" />
      </div>
    );
  }

  return (
    <div className="relative mt-4 px-1" data-testid="org-switcher">
      <button
        type="button"
        onClick={() => {
          setMenuOpen((v) => !v);
          setError(null);
        }}
        data-testid="button-org-switcher"
        aria-expanded={menuOpen}
        className="flex w-full items-center justify-between gap-2 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-2.5 py-2 text-left transition-colors hover:bg-[hsl(var(--muted))/0.6]"
      >
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[hsl(var(--primary))/0.12] text-[hsl(var(--primary))]">
            <Building2 size={14} />
          </div>
          <div className="min-w-0">
            <div className="truncate text-xs font-semibold text-[hsl(var(--foreground))]">
              {activeOrg.name}
            </div>
            <div className="text-[10px] capitalize text-[hsl(var(--muted-foreground))]">
              {activeOrg.role} workspace
            </div>
          </div>
        </div>
        <ChevronDown
          size={14}
          className={`shrink-0 text-[hsl(var(--muted-foreground))] transition-transform ${menuOpen ? "rotate-180" : ""}`}
        />
      </button>

      {menuOpen && (
        <div
          className="absolute left-1 right-1 z-30 mt-1.5 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-1.5 shadow-lg"
          data-testid="org-switcher-menu"
        >
          <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
            Workspaces ({organizations.length})
          </div>
          <div className="max-h-48 space-y-0.5 overflow-y-auto">
            {organizations.map((org) => {
              const isCurrent = org.id === activeOrg.id;
              return (
                <button
                  key={org.id}
                  type="button"
                  disabled={switchOrg.isPending}
                  onClick={() => void handleSwitch(org.id)}
                  data-testid={`org-option-${org.id}`}
                  className={`flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
                    isCurrent
                      ? "bg-[hsl(var(--primary))/0.10] font-semibold text-[hsl(var(--primary))]"
                      : "text-[hsl(var(--foreground))] hover:bg-[hsl(var(--muted))]"
                  }`}
                >
                  <span className="truncate">{org.name}</span>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Badge
                      className={
                        org.role === "owner"
                          ? "border-[hsl(var(--primary))/0.3] bg-[hsl(var(--primary))/0.1] text-[hsl(var(--primary))]"
                          : "border-[hsl(var(--border))] bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]"
                      }
                    >
                      {org.role}
                    </Badge>
                    {isCurrent && <Check size={12} />}
                  </div>
                </button>
              );
            })}
          </div>
          <div className="mt-1.5 border-t border-[hsl(var(--border))] pt-1.5">
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                setCreateOpen(true);
                setError(null);
              }}
              data-testid="button-new-org"
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs font-semibold text-[hsl(var(--primary))] hover:bg-[hsl(var(--primary))/0.08]"
            >
              <Plus size={13} />
              <span>Create workspace</span>
            </button>
          </div>
          {error && (
            <p className="mt-1 px-2 text-[11px] text-[hsl(var(--destructive))]">
              {error}
            </p>
          )}
        </div>
      )}

      {createOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
          data-testid="modal-create-org"
        >
          <div className="w-full max-w-md rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-6 shadow-xl">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-base font-bold text-[hsl(var(--foreground))]">
                  Create workspace
                </h2>
                <p className="mt-0.5 text-xs text-[hsl(var(--muted-foreground))]">
                  Start an isolated organization workspace with its own leads, calls, and team.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setCreateOpen(false)}
                className="text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]"
              >
                <X size={16} />
              </button>
            </div>

            <form onSubmit={(e) => void handleCreate(e)} className="mt-4 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-[hsl(var(--foreground))]">
                  Organization name
                </label>
                <input
                  type="text"
                  required
                  minLength={2}
                  maxLength={100}
                  value={orgName}
                  onChange={(e) => setOrgName(e.target.value)}
                  placeholder="e.g. Summit Realty Partners"
                  data-testid="input-org-name"
                  className="mt-1.5 w-full rounded-lg border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-3 py-2 text-xs outline-none focus:border-[hsl(var(--primary))]"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-[hsl(var(--foreground))]">
                    Industry vertical
                  </label>
                  <select
                    value={vertical}
                    onChange={(e) => setVertical(e.target.value as "real_estate" | "home_services")}
                    data-testid="select-org-vertical"
                    className="mt-1.5 w-full rounded-lg border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-2.5 py-2 text-xs outline-none focus:border-[hsl(var(--primary))]"
                  >
                    <option value="real_estate">Real Estate</option>
                    <option value="home_services">Home Services</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-[hsl(var(--foreground))]">
                    Market
                  </label>
                  <select
                    value={market}
                    onChange={(e) => setMarket(e.target.value as "US" | "IN")}
                    data-testid="select-org-market"
                    className="mt-1.5 w-full rounded-lg border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-2.5 py-2 text-xs outline-none focus:border-[hsl(var(--primary))]"
                  >
                    <option value="US">United States (US)</option>
                    <option value="IN">India (IN)</option>
                  </select>
                </div>
              </div>

              {error && (
                <p className="text-xs font-medium text-[hsl(var(--destructive))]" role="alert">
                  {error}
                </p>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" onClick={() => setCreateOpen(false)}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={createOrg.isPending}
                  data-testid="button-submit-create-org"
                >
                  {createOrg.isPending && <Loader2 size={13} className="animate-spin" />}
                  {createOrg.isPending ? "Creating…" : "Create workspace"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
