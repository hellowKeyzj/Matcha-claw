import { describe, expect, it, vi } from 'vitest';
import { createSessionListTransport } from '../../electron/main/runtime-host-delivery/transport/sessions/list';

const endpoint = {
  kind: 'native-runtime',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
} as const;
const matchaEndpoint = {
  kind: 'native-runtime',
  runtimeAdapterId: 'matcha-agent',
  runtimeInstanceId: 'local',
} as const;
const request = {
  id: 'session.management',
  operationId: 'sessions.list',
  scope: { kind: 'runtime-instance', endpoint },
  target: { kind: 'runtime-endpoint' },
  input: { endpoint },
} as const;
const session = {
  key: 'agent:agent-1:session-1',
  agentId: 'agent-1',
  sessionIdentity: {
    endpoint,
    agentId: 'agent-1',
    sessionKey: 'agent:agent-1:session-1',
  },
  kind: 'session',
  endpointSessionId: 'session-1',
  updatedAt: 1_717_171_717_000,
} as const;

describe('Electron Main session-list transport', () => {
  it('signs only the fixed local OpenClaw session-list request', async () => {
    const signDecision = vi.fn().mockReturnValue('signed-decision');
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ sessions: [session] }),
    });
    const transport = createSessionListTransport({ verificationKey: 'public', signDecision }, 34_101, fetcher);

    await expect(transport.list(request)).resolves.toEqual({
      status: 200,
      body: { sessions: [session] },
    });
    expect(signDecision).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: '/api/sessions',
      scope: 'sessions:read',
      capability: 'sessions.list',
      subject: 'session-catalog',
    }));
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:34101/api/sessions', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer signed-decision' }),
      body: JSON.stringify(request),
    }));
  });

  it.each([
    { ...request, input: { endpoint: { ...endpoint, runtimeInstanceId: 'remote' } } },
    { ...request, privateToken: 'secret' },
  ])('fails closed before issuing a decision for invalid requests', async (invalid) => {
    const signDecision = vi.fn();
    const fetcher = vi.fn();
    const transport = createSessionListTransport({ verificationKey: 'public', signDecision }, 34_101, fetcher);

    await expect(transport.list(invalid)).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Session catalog is unavailable' },
    });
    expect(signDecision).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('accepts automation session catalog rows', async () => {
    const automationSession = {
      ...session,
      key: 'agent:agent-1:cron:heartbeat-main',
      sessionIdentity: {
        ...session.sessionIdentity,
        sessionKey: 'agent:agent-1:cron:heartbeat-main',
      },
      kind: 'automation',
      endpointSessionId: 'cron:heartbeat-main',
    } as const;
    const transport = createSessionListTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_101,
      vi.fn().mockResolvedValue({ status: 200, json: async () => ({ sessions: [automationSession] }) }),
    );

    await expect(transport.list(request)).resolves.toEqual({
      status: 200,
      body: { sessions: [automationSession] },
    });
  });

  it('accepts session catalog rows that carry a model', async () => {
    const modeledSession = { ...session, model: 'provider/selected-model' } as const;
    const transport = createSessionListTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_101,
      vi.fn().mockResolvedValue({ status: 200, json: async () => ({ sessions: [modeledSession] }) }),
    );

    await expect(transport.list(request)).resolves.toEqual({
      status: 200,
      body: { sessions: [modeledSession] },
    });
  });

  it('accepts Matcha session catalog rows on the same route without dropping projection fields', async () => {
    const matchaRequest = {
      id: 'session.management',
      operationId: 'sessions.list',
      scope: { kind: 'runtime-instance', endpoint: matchaEndpoint },
      target: { kind: 'runtime-endpoint' },
      input: { endpoint: matchaEndpoint },
    } as const;
    const matchaSession = {
      key: 'matcha-agent:matcha:native-session-1',
      agentId: 'matcha',
      sessionIdentity: {
        endpoint: matchaEndpoint,
        agentId: 'matcha',
        sessionKey: 'matcha-agent:matcha:native-session-1',
      },
      kind: 'session',
      preferred: false,
      endpointSessionId: 'native-session-1',
      protocolId: 'matcha-agent-app-server',
      runtimeEndpointId: 'matcha-agent-local',
      updatedAt: 1_728_000_000_000,
    } as const;
    const transport = createSessionListTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_101,
      vi.fn().mockResolvedValue({ status: 200, json: async () => ({ sessions: [matchaSession] }) }),
    );

    await expect(transport.list(matchaRequest)).resolves.toEqual({
      status: 200,
      body: { sessions: [matchaSession] },
    });
  });

  it.each([
    {
      name: 'identity agent binding mismatch',
      body: { sessions: [{ ...session, sessionIdentity: { ...session.sessionIdentity, agentId: 'other-agent' } }] },
    },
    {
      name: 'identity session binding mismatch',
      body: { sessions: [{ ...session, sessionIdentity: { ...session.sessionIdentity, sessionKey: 'other-session' } }] },
    },
    {
      name: 'native catalog metadata',
      body: {
        sessions: [{
          ...session,
          label: 'native label',
          displayName: 'native display name',
          derivedTitle: 'native title',
          status: 'active',
          hasActiveRun: true,
        }],
      },
    },
    {
      name: 'private canary',
      body: { sessions: [{ ...session, privateToken: 'secret' }] },
    },
  ])('fails closed when a successful response has a $name', async ({ body }) => {
    const transport = createSessionListTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_101,
      vi.fn().mockResolvedValue({ status: 200, json: async () => body }),
    );

    await expect(transport.list(request)).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Session catalog is unavailable' },
    });
  });

  it('redacts unexpected transport failures as unavailable', async () => {
    const transport = createSessionListTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_101,
      vi.fn().mockRejectedValue(new Error('private native token')),
    );

    const response = await transport.list(request);
    expect(response).toEqual({
      status: 503,
      body: { success: false, error: 'Session catalog is unavailable' },
    });
    expect(JSON.stringify(response)).not.toContain('private native token');
  });
});
