import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Copy,
  KeyRound,
  Loader2,
  Lock,
  Plus,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import {
  getGetOnboardingChecklistQueryKey,
  getListApiKeysQueryKey,
  getListProviderCredentialsQueryKey,
  useCreateApiKey,
  useDeleteProviderCredentials,
  useGetAuthMe,
  useListApiKeys,
  useListProviderCredentials,
  useRevokeApiKey,
  useUpsertProviderCredentials,
  type CredentialProvider,
} from "@workspace/api-client-react";
import { Badge, Button, Section, Skeleton } from "@/components/common";

const PROVIDER_FIELDS: Record<
  CredentialProvider,
  {
    label: string;
    description: string;
    fields: Array<{ key: string; label: string; secret?: boolean; placeholder?: string }>;
  }
> = {
  intake: {
    label: "Lead Intake Webhook Secret",
    description: "Tenant-specific HMAC signing secret for incoming Meta, Zapier, and form webhooks.",
    fields: [
      { key: "webhook_secret", label: "Webhook signing secret", secret: true, placeholder: "Enter new signing secret" },
    ],
  },
  retell: {
    label: "Retell AI Voice",
    description: "Encrypted per-workspace Retell API key, webhook secret, and caller ID numbers.",
    fields: [
      { key: "api_key", label: "Retell API key", secret: true, placeholder: "key_..." },
      { key: "webhook_secret", label: "Retell webhook key (optional override)", secret: true, placeholder: "Optional webhook badge key" },
      { key: "agent_id", label: "Agent ID", placeholder: "agent_..." },
      { key: "from_number_us", label: "US from-number", placeholder: "+12125550100" },
      { key: "from_number_in", label: "India (+91) from-number", placeholder: "+912255500100" },
    ],
  },
  twilio: {
    label: "Twilio Telephony & SMS",
    description: "Encrypted Twilio Account SID, Auth Token, and regional sender numbers.",
    fields: [
      { key: "account_sid", label: "Account SID", placeholder: "AC..." },
      { key: "auth_token", label: "Auth Token", secret: true, placeholder: "Enter auth token" },
      { key: "us_from_number", label: "US SMS number", placeholder: "+12125550100" },
      { key: "india_from_number", label: "India SMS number", placeholder: "+91..." },
    ],
  },
  calcom: {
    label: "Cal.com Scheduling",
    description: "Encrypted Cal.com v2 API key, event type ID, and booking webhook secret.",
    fields: [
      { key: "api_key", label: "Cal.com API key", secret: true, placeholder: "cal_live_..." },
      { key: "event_type_id", label: "Event type ID", placeholder: "123456" },
      { key: "webhook_secret", label: "Cal.com webhook secret", secret: true, placeholder: "Enter webhook secret" },
    ],
  },
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

export function SecuritySettingsPanel() {
  const queryClient = useQueryClient();
  const authMe = useGetAuthMe();
  const role = authMe.data?.active_role ?? authMe.data?.user?.role;
  const isAdmin = role === "owner" || role === "admin";

  const keysQuery = useListApiKeys({
    query: { queryKey: getListApiKeysQueryKey(), enabled: isAdmin },
  });
  const credsQuery = useListProviderCredentials({
    query: { queryKey: getListProviderCredentialsQueryKey(), enabled: isAdmin },
  });

  const createKey = useCreateApiKey();
  const revokeKey = useRevokeApiKey();
  const upsertCreds = useUpsertProviderCredentials();
  const deleteCreds = useDeleteProviderCredentials();

  const [keyName, setKeyName] = useState("");
  const [newlyCreatedSecret, setNewlyCreatedSecret] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);
  const [editingProvider, setEditingProvider] = useState<CredentialProvider | null>(null);
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [statusMessage, setStatusMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  if (!isAdmin) return null;

  const handleCreateKey = async (e: FormEvent) => {
    e.preventDefault();
    if (keyName.trim().length < 2) return;
    setStatusMessage(null);
    try {
      const created = await createKey.mutateAsync({
        data: { name: keyName.trim(), scopes: ["leads:intake"] },
      });
      setNewlyCreatedSecret(created.secret_key);
      setCopiedKey(false);
      setKeyName("");
      await queryClient.invalidateQueries({ queryKey: getListApiKeysQueryKey() });
    } catch (err) {
      setStatusMessage({ tone: "error", text: getErrorMessage(err, "Failed to create API key") });
    }
  };

  const handleRevokeKey = async (keyId: string) => {
    setStatusMessage(null);
    try {
      await revokeKey.mutateAsync({ keyId });
      setStatusMessage({ tone: "success", text: "API key revoked." });
      await queryClient.invalidateQueries({ queryKey: getListApiKeysQueryKey() });
    } catch (err) {
      setStatusMessage({ tone: "error", text: getErrorMessage(err, "Failed to revoke API key") });
    }
  };

  const handleSaveCredentials = async (e: FormEvent) => {
    e.preventDefault();
    if (!editingProvider) return;
    setStatusMessage(null);
    const nonEmpty: Record<string, string> = {};
    for (const [k, v] of Object.entries(formValues)) {
      if (v.trim()) nonEmpty[k] = v.trim();
    }
    try {
      await upsertCreds.mutateAsync({
        provider: editingProvider,
        data: { config: nonEmpty },
      });
      setEditingProvider(null);
      setFormValues({});
      setStatusMessage({ tone: "success", text: `Encrypted ${editingProvider} credentials saved.` });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getListProviderCredentialsQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetOnboardingChecklistQueryKey() }),
      ]);
    } catch (err) {
      setStatusMessage({ tone: "error", text: getErrorMessage(err, "Unable to save encrypted credentials") });
    }
  };

  const handleDeleteCredentials = async (provider: CredentialProvider) => {
    setStatusMessage(null);
    try {
      await deleteCreds.mutateAsync({ provider });
      setStatusMessage({ tone: "success", text: `Removed stored ${provider} credentials.` });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getListProviderCredentialsQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetOnboardingChecklistQueryKey() }),
      ]);
    } catch (err) {
      setStatusMessage({ tone: "error", text: getErrorMessage(err, "Unable to remove credentials") });
    }
  };

  const copySecret = async () => {
    if (!newlyCreatedSecret) return;
    await navigator.clipboard.writeText(newlyCreatedSecret);
    setCopiedKey(true);
  };

  return (
    <div className="space-y-6 pt-2" data-testid="security-settings-panel">
      {statusMessage && (
        <div
          role="status"
          className={`rounded-xl border px-4 py-3 text-xs font-medium ${
            statusMessage.tone === "success"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-red-200 bg-red-50 text-red-700"
          }`}
        >
          {statusMessage.text}
        </div>
      )}

      <Section
        title="Tenant API Keys"
        description="Scoped API keys for inbound lead intake (Bearer or X-Api-Key). Keys are hashed with SHA-256 and never stored in plaintext."
      >
        <form onSubmit={(e) => void handleCreateKey(e)} className="mt-4 flex flex-wrap gap-2">
          <input
            type="text"
            required
            minLength={2}
            maxLength={80}
            value={keyName}
            onChange={(e) => setKeyName(e.target.value)}
            placeholder="e.g. Meta Lead Ads Connector"
            data-testid="input-api-key-name"
            className="min-w-[220px] flex-1 rounded-lg border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-3 py-2 text-xs outline-none focus:border-[hsl(var(--primary))]"
          />
          <Button type="submit" variant="primary" disabled={createKey.isPending} data-testid="button-create-api-key">
            {createKey.isPending ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
            Create intake key
          </Button>
        </form>

        {newlyCreatedSecret && (
          <div
            className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-4 text-xs"
            data-testid="new-api-key-banner"
          >
            <p className="font-bold text-amber-900">
              Copy this API key now — it will never be displayed again:
            </p>
            <div className="mt-2 flex items-center gap-2">
              <code className="flex-1 break-all rounded-md border border-amber-200 bg-white px-3 py-2 font-mono text-[11px] text-slate-900">
                {newlyCreatedSecret}
              </code>
              <Button type="button" size="sm" onClick={() => void copySecret()}>
                {copiedKey ? <Check size={13} /> : <Copy size={13} />}
                {copiedKey ? "Copied" : "Copy"}
              </Button>
            </div>
          </div>
        )}

        <div className="mt-4 divide-y divide-[hsl(var(--border))] rounded-lg border border-[hsl(var(--border))]">
          {keysQuery.isLoading ? (
            <div className="p-4"><Skeleton className="h-12 w-full" /></div>
          ) : (keysQuery.data?.keys ?? []).length === 0 ? (
            <div className="p-4 text-xs text-[hsl(var(--muted-foreground))]">
              No tenant API keys created yet.
            </div>
          ) : (
            keysQuery.data!.keys.map((k) => (
              <div key={k.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-xs">
                <div>
                  <div className="flex items-center gap-2">
                    <KeyRound size={13} className="text-[hsl(var(--muted-foreground))]" />
                    <span className="font-semibold text-[hsl(var(--foreground))]">{k.name}</span>
                    <code className="rounded bg-[hsl(var(--muted))] px-1.5 py-0.5 font-mono text-[11px]">
                      {k.key_prefix}…
                    </code>
                    {k.revoked_at ? (
                      <Badge className="border-[hsl(var(--border))] bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]">
                        Revoked
                      </Badge>
                    ) : (
                      <Badge className="border-emerald-200 bg-emerald-50 text-emerald-800">
                        Active
                      </Badge>
                    )}
                  </div>
                  <div className="mt-0.5 text-[11px] text-[hsl(var(--muted-foreground))]">
                    Scopes: {k.scopes.join(", ")} · Last used:{" "}
                    {k.last_used_at ? new Date(k.last_used_at).toLocaleString() : "Never"}
                  </div>
                </div>
                {!k.revoked_at && (
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => void handleRevokeKey(k.id)}
                    disabled={revokeKey.isPending}
                    data-testid={`button-revoke-key-${k.id}`}
                    className="text-[hsl(var(--destructive))]"
                  >
                    <Trash2 size={13} />
                    Revoke
                  </Button>
                )}
              </div>
            ))
          )}
        </div>
      </Section>

      <Section
        title="Encrypted Provider Credentials (AES-256-GCM)"
        description="Per-workspace secrets for inbound webhooks, Retell, Twilio, and Cal.com. Decrypted values are never returned to the browser."
      >
        {credsQuery.data && !credsQuery.data.encryption_configured && (
          <div className="mt-4 flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-900">
            <ShieldAlert size={15} className="shrink-0" />
            <span>
              <code>APP_ENCRYPTION_KEY</code> is not configured on the server; saving new encrypted credentials is disabled.
            </span>
          </div>
        )}

        <div className="mt-4 divide-y divide-[hsl(var(--border))] rounded-lg border border-[hsl(var(--border))]">
          {credsQuery.isLoading ? (
            <div className="p-4"><Skeleton className="h-24 w-full" /></div>
          ) : (
            (credsQuery.data?.credentials ?? []).map((cred) => {
              const meta = PROVIDER_FIELDS[cred.provider];
              const isEditing = editingProvider === cred.provider;
              return (
                <div key={cred.provider} className="p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <Lock size={13} className="text-[hsl(var(--muted-foreground))]" />
                        <span className="text-xs font-semibold text-[hsl(var(--foreground))]">
                          {meta.label}
                        </span>
                        {cred.configured ? (
                          <Badge className="border-emerald-200 bg-emerald-50 text-emerald-800">
                            Encrypted (v{cred.key_version ?? 1})
                          </Badge>
                        ) : (
                          <Badge className="border-[hsl(var(--border))] bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]">
                            Using env fallback / unset
                          </Badge>
                        )}
                      </div>
                      <p className="mt-0.5 text-[11px] text-[hsl(var(--muted-foreground))]">
                        {meta.description}
                      </p>
                      {cred.configured && Object.keys(cred.masked_hints).length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-2 font-mono text-[11px] text-[hsl(var(--muted-foreground))]">
                          {Object.entries(cred.masked_hints).map(([k, v]) => (
                            <span key={k} className="rounded bg-[hsl(var(--muted))] px-1.5 py-0.5">
                              {k}: {v}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => {
                          setEditingProvider(isEditing ? null : cred.provider);
                          setFormValues({});
                        }}
                        data-testid={`button-edit-cred-${cred.provider}`}
                      >
                        {isEditing ? "Close" : cred.configured ? "Rotate / Edit" : "Configure"}
                      </Button>
                      {cred.configured && (
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => void handleDeleteCredentials(cred.provider)}
                          disabled={deleteCreds.isPending}
                          data-testid={`button-delete-cred-${cred.provider}`}
                          className="text-[hsl(var(--destructive))]"
                        >
                          Clear
                        </Button>
                      )}
                    </div>
                  </div>

                  {isEditing && (
                    <form onSubmit={(e) => void handleSaveCredentials(e)} className="mt-4 grid gap-3 rounded-lg bg-[hsl(var(--muted))/0.4] p-4 sm:grid-cols-2">
                      {meta.fields.map((field) => (
                        <div key={field.key} className="space-y-1">
                          <label className="block text-[11px] font-semibold text-[hsl(var(--foreground))]">
                            {field.label}
                          </label>
                          <input
                            type={field.secret ? "password" : "text"}
                            autoComplete="off"
                            value={formValues[field.key] ?? ""}
                            onChange={(e) =>
                              setFormValues((prev) => ({ ...prev, [field.key]: e.target.value }))
                            }
                            placeholder={field.placeholder}
                            className="w-full rounded-md border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-2.5 py-1.5 text-xs outline-none focus:border-[hsl(var(--primary))]"
                          />
                        </div>
                      ))}
                      <div className="flex justify-end gap-2 sm:col-span-2">
                        <Button type="button" size="sm" onClick={() => setEditingProvider(null)}>
                          Cancel
                        </Button>
                        <Button
                          type="submit"
                          size="sm"
                          variant="primary"
                          disabled={upsertCreds.isPending}
                          data-testid={`button-save-cred-${cred.provider}`}
                        >
                          {upsertCreds.isPending && <Loader2 size={12} className="animate-spin" />}
                          Save encrypted
                        </Button>
                      </div>
                    </form>
                  )}
                </div>
              );
            })
          )}
        </div>
      </Section>
    </div>
  );
}

