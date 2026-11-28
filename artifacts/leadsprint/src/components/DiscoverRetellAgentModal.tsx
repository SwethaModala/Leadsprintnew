import { useState } from 'react';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ExternalLink,
  Globe,
  Loader2,
  Mic,
  RefreshCw,
  X,
} from 'lucide-react';
import {
  Badge,
  Button,
} from '@/components/common';
import {
  useGetAgentsRetellRemote,
  usePostAgents,
  usePostAgentsAgentIdRetellLink,
  usePostPhoneNumbersSync,
} from '@workspace/api-client-react';

interface DiscoverRetellAgentModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  existingAgents: Array<{ id: string; name: string; retell_agent_id?: string | null }>;
}

export function DiscoverRetellAgentModal({
  isOpen,
  onClose,
  onSuccess,
  existingAgents,
}: DiscoverRetellAgentModalProps) {
  const [selectedRemoteAgentId, setSelectedRemoteAgentId] = useState<string | null>(null);
  const [linkTarget, setLinkTarget] = useState<'create_new' | string>('create_new');
  const [newAgentName, setNewAgentName] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  const {
    data: remoteData,
    isLoading,
    isError,
    error,
    refetch,
  } = useGetAgentsRetellRemote({
    query: {
      queryKey: ['/api/agents/retell/remote'],
      enabled: isOpen,
    },
  });

  const createAgent = usePostAgents();
  const linkAgent = usePostAgentsAgentIdRetellLink();
  const syncPhones = usePostPhoneNumbersSync();

  if (!isOpen) return null;

  const remoteAgents = remoteData?.agents ?? [];
  const selectedRemote = remoteAgents.find((a) => a.retell_agent_id === selectedRemoteAgentId);

  const handleSelectRemote = (agent: (typeof remoteAgents)[number]) => {
    setSelectedRemoteAgentId(agent.retell_agent_id);
    setActionError(null);
    setActionSuccess(null);
    if (!newAgentName) {
      setNewAgentName(agent.agent_name || `Retell Agent (${agent.retell_agent_id.slice(0, 8)})`);
    }
  };

  const isSubmitting = createAgent.isPending || linkAgent.isPending || syncPhones.isPending;

  const handleLinkOrImport = async () => {
    if (!selectedRemote) return;
    setActionError(null);
    setActionSuccess(null);

    try {
      if (linkTarget === 'create_new') {
        const nameToUse = newAgentName.trim() || selectedRemote.agent_name || `Retell Agent ${selectedRemote.retell_agent_id.slice(0, 6)}`;
        await createAgent.mutateAsync({
          data: {
            name: nameToUse,
            use_case: 'real_estate',
            voice_id: selectedRemote.voice_id ?? undefined,
            retell_agent_id: selectedRemote.retell_agent_id,
            status: 'active',
          },
        });
      } else {
        await linkAgent.mutateAsync({
          agentId: linkTarget,
          data: {
            retell_agent_id: selectedRemote.retell_agent_id,
            status: 'active',
          },
        });
      }

      // Synchronize phone numbers from Retell to ensure numbers pick up the agent
      try {
        await syncPhones.mutateAsync(undefined);
      } catch (phoneErr) {
        // Non-blocking if phone sync fails or has no numbers
      }

      setActionSuccess(`Successfully linked Retell agent "${selectedRemote.agent_name || selectedRemote.retell_agent_id}" as active agent.`);
      setTimeout(() => {
        onSuccess();
        onClose();
      }, 1200);
    } catch (err: any) {
      const msg = err?.data?.error ?? err?.message ?? 'Failed to link Retell agent. Please try again.';
      setActionError(msg);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm animate-fade-in"
      data-testid="modal-discover-retell"
    >
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[hsl(var(--border))] px-6 py-4">
          <div className="flex items-center gap-2">
            <Bot className="h-5 w-5 text-[hsl(var(--primary))]" />
            <h2 className="text-base font-semibold text-[hsl(var(--foreground))]">
              Discover & Link Retell AI Agents
            </h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))] hover:text-[hsl(var(--foreground))]"
            data-testid="button-close-discover-modal"
          >
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          <p className="text-xs text-[hsl(var(--muted-foreground))]">
            Select an existing agent configured in your Retell AI account. Linking it will set it as your active LeadSprint sales agent and synchronize phone numbers.
          </p>

          {isLoading && (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Loader2 className="h-8 w-8 animate-spin text-[hsl(var(--primary))]" />
              <p className="mt-3 text-sm text-[hsl(var(--muted-foreground))]">
                Fetching agents from your Retell account…
              </p>
            </div>
          )}

          {isError && (
            <div
              className="rounded-lg border border-[hsl(var(--destructive)/0.3)] bg-[hsl(var(--destructive)/0.08)] p-4 text-xs text-[hsl(var(--destructive))]"
              data-testid="text-remote-fetch-error"
            >
              <div className="flex items-center gap-2 font-semibold">
                <AlertTriangle size={15} />
                Failed to discover Retell agents
              </div>
              <p className="mt-1">
                {(error as any)?.data?.error ?? (error as any)?.message ?? 'Ensure RETELL_API_KEY is configured in your workspace credentials or environment.'}
              </p>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => refetch()}
                className="mt-3"
                data-testid="button-retry-fetch-remote"
              >
                <RefreshCw size={12} className="mr-1.5" />
                Retry discovery
              </Button>
            </div>
          )}

          {!isLoading && !isError && remoteAgents.length === 0 && (
            <div className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.3)] p-6 text-center">
              <Bot size={28} className="mx-auto mb-2 opacity-40 text-[hsl(var(--muted-foreground))]" />
              <p className="text-sm font-medium text-[hsl(var(--foreground))]">No agents found in Retell account</p>
              <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">
                No voice agents were returned by the Retell API. Create an agent in Retell Dashboard first.
              </p>
            </div>
          )}

          {!isLoading && !isError && remoteAgents.length > 0 && (
            <div className="space-y-4">
              <label className="block text-xs font-semibold text-[hsl(var(--muted-foreground))]">
                Available Retell Agents ({remoteAgents.length})
              </label>
              <div className="grid max-h-60 gap-2 overflow-y-auto pr-1">
                {remoteAgents.map((agent) => {
                  const isSelected = selectedRemoteAgentId === agent.retell_agent_id;
                  const alreadyLinkedTo = existingAgents.find((ea) => ea.retell_agent_id === agent.retell_agent_id);

                  return (
                    <div
                      key={agent.retell_agent_id}
                      onClick={() => handleSelectRemote(agent)}
                      className={`flex cursor-pointer items-start justify-between rounded-lg border p-3.5 transition-colors ${
                        isSelected
                          ? 'border-[hsl(var(--primary))] bg-[hsl(var(--primary)/0.06)] ring-1 ring-[hsl(var(--primary))]'
                          : 'border-[hsl(var(--border))] hover:bg-[hsl(var(--muted)/0.4)]'
                      }`}
                      data-testid={`remote-agent-card-${agent.retell_agent_id}`}
                    >
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-[hsl(var(--foreground))]">
                            {agent.agent_name || 'Unnamed Agent'}
                          </span>
                          {alreadyLinkedTo && (
                            <Badge className="border-[hsl(var(--border))] bg-[hsl(var(--muted))] text-[10px] text-[hsl(var(--muted-foreground))]">
                              Linked to "{alreadyLinkedTo.name}"
                            </Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-3 text-[11px] text-[hsl(var(--muted-foreground))]">
                          <span className="font-mono">{agent.retell_agent_id}</span>
                          {agent.voice_id && (
                            <span className="flex items-center gap-1">
                              <Mic size={11} />
                              {agent.voice_id}
                            </span>
                          )}
                          {agent.language && (
                            <span className="flex items-center gap-1">
                              <Globe size={11} />
                              {agent.language}
                            </span>
                          )}
                        </div>
                      </div>
                      <input
                        type="radio"
                        name="remote-agent"
                        checked={isSelected}
                        onChange={() => handleSelectRemote(agent)}
                        className="mt-1 h-4 w-4 text-[hsl(var(--primary))]"
                      />
                    </div>
                  );
                })}
              </div>

              {selectedRemote && (
                <div className="space-y-4 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.2)] p-4 animate-fade-in">
                  <h4 className="text-xs font-semibold text-[hsl(var(--foreground))] uppercase tracking-wider">
                    Linking Options for {selectedRemote.agent_name || selectedRemote.retell_agent_id}
                  </h4>

                  <div className="space-y-2">
                    <label className="flex items-center gap-2 text-xs font-medium cursor-pointer">
                      <input
                        type="radio"
                        name="link-target-mode"
                        value="create_new"
                        checked={linkTarget === 'create_new'}
                        onChange={() => setLinkTarget('create_new')}
                        data-testid="radio-create-new-agent"
                      />
                      Create as a new active local agent
                    </label>
                    {linkTarget === 'create_new' && (
                      <div className="pl-6 pt-1">
                        <input
                          type="text"
                          value={newAgentName}
                          onChange={(e) => setNewAgentName(e.target.value)}
                          placeholder="Agent name (e.g. Inbound Sales Rep)"
                          className="w-full rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-3 py-1.5 text-xs text-[hsl(var(--foreground))] focus:outline-none focus:ring-1 focus:ring-[hsl(var(--primary))]"
                          data-testid="input-new-agent-name"
                        />
                      </div>
                    )}
                  </div>

                  {existingAgents.length > 0 && (
                    <div className="space-y-2">
                      <label className="flex items-center gap-2 text-xs font-medium cursor-pointer">
                        <input
                          type="radio"
                          name="link-target-mode"
                          value="existing"
                          checked={linkTarget !== 'create_new'}
                          onChange={() => setLinkTarget(existingAgents[0].id)}
                          data-testid="radio-link-existing-agent"
                        />
                        Link to an existing local agent
                      </label>
                      {linkTarget !== 'create_new' && (
                        <div className="pl-6 pt-1">
                          <select
                            value={linkTarget}
                            onChange={(e) => setLinkTarget(e.target.value)}
                            className="w-full rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-3 py-1.5 text-xs text-[hsl(var(--foreground))] focus:outline-none focus:ring-1 focus:ring-[hsl(var(--primary))]"
                            data-testid="select-existing-agent-target"
                          >
                            {existingAgents.map((ea) => (
                              <option key={ea.id} value={ea.id}>
                                {ea.name} {ea.retell_agent_id ? `(Current: ${ea.retell_agent_id.slice(0, 8)}…)` : '(Unlinked)'}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {actionError && (
            <div
              className="flex items-center gap-2 rounded-lg border border-[hsl(var(--destructive)/0.3)] bg-[hsl(var(--destructive)/0.08)] p-3 text-xs text-[hsl(var(--destructive))]"
              data-testid="text-link-action-error"
            >
              <AlertTriangle size={14} className="shrink-0" />
              <span>{actionError}</span>
            </div>
          )}

          {actionSuccess && (
            <div
              className="flex items-center gap-2 rounded-lg border border-[hsl(var(--success)/0.3)] bg-[hsl(var(--success)/0.08)] p-3 text-xs text-[hsl(var(--success))]"
              data-testid="text-link-action-success"
            >
              <CheckCircle2 size={14} className="shrink-0" />
              <span>{actionSuccess}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-[hsl(var(--border))] px-6 py-4">
          <Button
            variant="secondary"
            size="sm"
            onClick={onClose}
            disabled={isSubmitting}
            data-testid="button-cancel-discover"
          >
            Cancel
          </Button>

          <Button
            variant="primary"
            size="sm"
            onClick={handleLinkOrImport}
            disabled={!selectedRemote || isSubmitting}
            data-testid="button-confirm-link-remote"
          >
            {isSubmitting ? (
              <>
                <Loader2 size={13} className="mr-1.5 animate-spin" />
                Linking & syncing…
              </>
            ) : (
              'Link & Activate Agent'
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
