import { useState } from 'react';
import { Link } from 'wouter';
import {
  Bot,
  Copy,
  Filter,
  Pause,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Search,
} from 'lucide-react';
import {
  Badge,
  Button,
  PageHeader,
  Section,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/common';
import { DiscoverRetellAgentModal } from '@/components/DiscoverRetellAgentModal';
import {
  useGetAgents,
  usePostAgents,
  usePatchAgentsAgentId,
  useDeleteAgentsAgentId,
  usePostPhoneNumbersSync,
  useGetPhoneNumbers,
} from '@workspace/api-client-react';

function statusColorClass(status: string) {
  switch (status) {
    case 'active': return 'bg-emerald-50 text-emerald-700 border-emerald-200';
    case 'paused': return 'bg-amber-50 text-amber-700 border-amber-200';
    default: return 'bg-slate-50 text-slate-700 border-slate-200';
  }
}

export default function AgentsPage() {
  const [search, setSearch] = useState('');
  const [selectedStatus, setSelectedStatus] = useState('all');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [isDiscoverModalOpen, setIsDiscoverModalOpen] = useState(false);

  const { data: agentsData, isLoading, refetch } = useGetAgents();
  const { data: phoneData, refetch: refetchPhones } = useGetPhoneNumbers();
  const patchAgent = usePatchAgentsAgentId();
  const deleteAgent = useDeleteAgentsAgentId();
  const syncPhones = usePostPhoneNumbersSync();
  const createAgent = usePostAgents();

  const agents = agentsData?.agents ?? [];
  const phoneNumbers = phoneData?.phone_numbers ?? [];

  const filtered = agents.filter((a) => {
    const matchesSearch =
      !search ||
      a.name.toLowerCase().includes(search.toLowerCase()) ||
      (a.retell_agent_id ?? '').toLowerCase().includes(search.toLowerCase());
    const matchesStatus = selectedStatus === 'all' || a.status === selectedStatus;
    return matchesSearch && matchesStatus;
  });

  const handleToggleStatus = (id: string, currentStatus: string) => {
    const newStatus = currentStatus === 'active' ? 'paused' : 'active';
    patchAgent.mutate(
      { agentId: id, data: { status: newStatus as 'active' | 'paused' } },
      { onSuccess: () => refetch() },
    );
  };

  const handleDelete = (id: string) => {
    if (!window.confirm('Delete this agent? This cannot be undone.')) return;
    deleteAgent.mutate(
      { agentId: id },
      { onSuccess: () => refetch() },
    );
  };

  const handleCopyId = (id: string) => {
    navigator.clipboard.writeText(id);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const handleSync = () => {
    syncPhones.mutate(undefined, { onSuccess: () => refetchPhones() });
  };

  return (
    <div className="animate-rise-in space-y-6">
      <PageHeader
        eyebrow="Console / AI agents"
        title="AI Agents"
        description="Manage LeadSprint AI agents and their Retell voice configurations."
        action={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setIsDiscoverModalOpen(true)}
              data-testid="button-discover-retell-agents"
            >
              <Radio size={14} className="text-[hsl(var(--primary))]" />
              Discover Retell agents
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={handleSync}
              disabled={syncPhones.isPending}
              data-testid="button-sync-phones"
            >
              <RefreshCw size={14} className={syncPhones.isPending ? 'animate-spin' : ''} />
              Sync phones
            </Button>
            <Link href="/workspace/agent-builder">
              <Button size="sm" data-testid="button-create-agent">
                <Plus size={14} />
                New agent
              </Button>
            </Link>
          </div>
        }
      />

      {/* Filters */}
      <Section>
        <div className="flex flex-wrap items-center gap-3 p-4">
          <div className="relative flex-1 min-w-48">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[hsl(var(--muted-foreground))]" />
            <input
              className="w-full rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] pl-9 pr-3 py-2 text-sm"
              placeholder="Search agents…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              data-testid="input-search-agents"
            />
          </div>
          <div className="flex items-center gap-2">
            <Filter size={14} className="text-[hsl(var(--muted-foreground))]" />
            <Select
              value={selectedStatus}
              onChange={(e) => setSelectedStatus(e.target.value)}
              data-testid="select-filter-status"
            >
              <option value="all">All statuses</option>
              <option value="active">Active</option>
              <option value="paused">Paused</option>
              <option value="draft">Draft</option>
            </Select>
          </div>
        </div>

        {/* Agents table */}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Use case</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Voice</TableHead>
              <TableHead>Retell ID</TableHead>
              <TableHead>Calls today</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-sm text-[hsl(var(--muted-foreground))] py-8">
                  Loading…
                </TableCell>
              </TableRow>
            )}
            {!isLoading && filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-sm text-[hsl(var(--muted-foreground))] py-8">
                  <Bot size={32} className="mx-auto mb-2 opacity-30" />
                  No agents yet. Create your first agent to get started.
                </TableCell>
              </TableRow>
            )}
            {filtered.map((agent) => (
              <TableRow key={agent.id} data-testid={`row-agent-${agent.id}`}>
                <TableCell className="font-medium">
                  <Link href={`/workspace/agent-builder?id=${agent.id}`} className="hover:underline">
                    {agent.name}
                  </Link>
                </TableCell>
                <TableCell className="text-sm capitalize">{(agent.use_case ?? '').replace('_', ' ')}</TableCell>
                <TableCell>
                  <Badge className={statusColorClass(agent.status ?? 'draft')}>
                    {agent.status ?? 'draft'}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm text-[hsl(var(--muted-foreground))]">
                  {agent.voice_id ?? '—'}
                </TableCell>
                <TableCell>
                  {agent.retell_agent_id ? (
                    <div className="flex items-center gap-1.5">
                      <code className="text-xs">{agent.retell_agent_id.slice(0, 20)}…</code>
                      <button
                        onClick={() => handleCopyId(agent.retell_agent_id!)}
                        className="text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]"
                        data-testid={`button-copy-${agent.id}`}
                      >
                        <Copy size={12} />
                      </button>
                      {copiedId === agent.retell_agent_id && (
                        <span className="text-xs text-[hsl(var(--primary))]">Copied</span>
                      )}
                    </div>
                  ) : (
                    <span className="text-xs text-[hsl(var(--muted-foreground))]">Not linked</span>
                  )}
                </TableCell>
                <TableCell className="tabular-nums">{agent.calls_today}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleToggleStatus(agent.id, agent.status ?? 'draft')}
                      className="inline-flex items-center gap-1.5 rounded-md border border-[hsl(var(--border))] px-2 py-1 text-xs hover:bg-[hsl(var(--muted))]"
                      disabled={patchAgent.isPending}
                      data-testid={`button-toggle-${agent.id}`}
                    >
                      {agent.status === 'active' ? <Pause size={12} /> : <Play size={12} />}
                      {agent.status === 'active' ? 'Pause' : 'Activate'}
                    </button>
                    <button
                      onClick={() => handleDelete(agent.id)}
                      className="inline-flex items-center rounded-md border border-[hsl(var(--destructive)/0.3)] px-2 py-1 text-xs text-[hsl(var(--destructive))] hover:bg-[hsl(var(--destructive)/0.07)]"
                      disabled={deleteAgent.isPending}
                      data-testid={`button-delete-${agent.id}`}
                    >
                      Delete
                    </button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>

      {/* Phone numbers */}
      {phoneNumbers.length > 0 && (
        <Section>
          <div className="p-4 pb-2">
            <h3 className="text-sm font-semibold">Phone Numbers</h3>
            <p className="text-xs text-[hsl(var(--muted-foreground))]">Synced from your Retell account</p>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Number</TableHead>
                <TableHead>Nickname</TableHead>
                <TableHead>Inbound agent</TableHead>
                <TableHead>Outbound agent</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {phoneNumbers.map((pn) => (
                <TableRow key={pn.id} data-testid={`row-phone-${pn.id}`}>
                  <TableCell className="font-mono text-sm">{pn.e164_number}</TableCell>
                  <TableCell className="text-sm">{pn.nickname ?? '—'}</TableCell>
                  <TableCell className="text-xs text-[hsl(var(--muted-foreground))]">
                    {pn.inbound_agent_id ?? '—'}
                  </TableCell>
                  <TableCell className="text-xs text-[hsl(var(--muted-foreground))]">
                    {pn.outbound_agent_id ?? '—'}
                  </TableCell>
                  <TableCell>
                    <Badge className={pn.is_active ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-slate-50 text-slate-700 border-slate-200'}>
                      {pn.is_active ? 'active' : 'inactive'}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>
      )}

      {createAgent.isError && (
        <p className="text-sm text-[hsl(var(--destructive))]" data-testid="error-create-agent">
          Failed to create agent. Please try again.
        </p>
      )}

      <DiscoverRetellAgentModal
        isOpen={isDiscoverModalOpen}
        onClose={() => setIsDiscoverModalOpen(false)}
        onSuccess={() => {
          refetch();
          refetchPhones();
        }}
        existingAgents={agents.map((a) => ({
          id: a.id,
          name: a.name,
          retell_agent_id: a.retell_agent_id,
        }))}
      />
    </div>
  );
}
