import { describe, expect, it } from 'vitest';

describe('Retell Discovery and Linking Logic', () => {
  interface RemoteAgent {
    agent_id: string;
    agent_name?: string | null;
    voice_id?: string | null;
    language?: string | null;
  }

  interface LocalAgent {
    id: string;
    name: string;
    retell_agent_id?: string | null;
    status: 'draft' | 'active' | 'paused';
  }

  function resolveLinkingPayload(params: {
    selectedRemote: RemoteAgent;
    linkTarget: 'create_new' | string;
    customName?: string;
  }) {
    if (params.linkTarget === 'create_new') {
      const name = params.customName?.trim() || params.selectedRemote.agent_name || `Retell Agent (${params.selectedRemote.agent_id.slice(0, 8)})`;
      return {
        action: 'create' as const,
        payload: {
          name,
          use_case: 'outbound_qualification',
          voice_id: params.selectedRemote.voice_id ?? undefined,
          retell_agent_id: params.selectedRemote.agent_id,
          status: 'active' as const,
        },
      };
    }

    return {
      action: 'link' as const,
      agentId: params.linkTarget,
      payload: {
        retell_agent_id: params.selectedRemote.agent_id,
        status: 'active' as const,
      },
    };
  }

  it('generates create payload with active status and remote agent attributes', () => {
    const remote: RemoteAgent = {
      agent_id: 'agent_remote_001',
      agent_name: 'Property Sales Assistant',
      voice_id: 'voice_11-labs_rachel',
      language: 'en-US',
    };

    const result = resolveLinkingPayload({
      selectedRemote: remote,
      linkTarget: 'create_new',
      customName: 'Custom Sales Bot',
    });

    expect(result.action).toBe('create');
    expect(result.payload.name).toBe('Custom Sales Bot');
    expect(result.payload.retell_agent_id).toBe('agent_remote_001');
    expect(result.payload.voice_id).toBe('voice_11-labs_rachel');
    expect(result.payload.status).toBe('active');
  });

  it('falls back to remote agent name or truncated id when custom name is empty', () => {
    const remote1: RemoteAgent = {
      agent_id: 'agent_remote_002',
      agent_name: 'Boomi Rep',
    };
    const res1 = resolveLinkingPayload({
      selectedRemote: remote1,
      linkTarget: 'create_new',
      customName: '',
    });
    expect(res1.payload.name).toBe('Boomi Rep');

    const remote2: RemoteAgent = {
      agent_id: 'agent_remote_003_long_string',
      agent_name: null,
    };
    const res2 = resolveLinkingPayload({
      selectedRemote: remote2,
      linkTarget: 'create_new',
    });
    expect(res2.payload.name).toBe('Retell Agent (agent_re)');
  });

  it('generates link payload targeting existing agent with active status', () => {
    const remote: RemoteAgent = {
      agent_id: 'agent_remote_004',
      agent_name: 'Existing Bot',
    };

    const result = resolveLinkingPayload({
      selectedRemote: remote,
      linkTarget: 'local_agent_999',
    });

    expect(result.action).toBe('link');
    if (result.action === 'link') {
      expect(result.agentId).toBe('local_agent_999');
      expect(result.payload.retell_agent_id).toBe('agent_remote_004');
      expect(result.payload.status).toBe('active');
    }
  });

  it('identifies if a remote agent is already linked to a local agent', () => {
    const localAgents: LocalAgent[] = [
      { id: '1', name: 'Sara', retell_agent_id: 'agent_abc_123', status: 'active' },
      { id: '2', name: 'Alex', retell_agent_id: null, status: 'draft' },
    ];

    const findLinked = (remoteId: string) =>
      localAgents.find((la) => la.retell_agent_id === remoteId);

    expect(findLinked('agent_abc_123')?.name).toBe('Sara');
    expect(findLinked('agent_xyz_789')).toBeUndefined();
  });
});
