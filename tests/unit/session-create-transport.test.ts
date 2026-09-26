import { describe, expect, it, vi } from 'vitest';
import { createSessionCreateTransport } from '../../electron/main/runtime-host-delivery/transport/sessions/create';
import { sessionView } from './helpers/session-fixtures';

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
  id: 'session.prompt',
  operationId: 'sessions.create',
  scope: { kind: 'agent', endpoint, agentId: 'main' },
  target: { kind: 'agent', agentId: 'main' },
  input: { endpoint, agentId: 'main', endpointSessionId: 'session-1' },
} as const;

const matchaRequest = {
  id: 'session.prompt',
  operationId: 'sessions.create',
  scope: { kind: 'agent', endpoint: matchaEndpoint, agentId: 'main' },
  target: { kind: 'agent', agentId: 'main' },
  input: { endpoint: matchaEndpoint, agentId: 'main', endpointSessionId: 'matcha-session-1' },
} as const;

const ordinaryOwnership = { kind: 'ordinary' } as const;
const teamOwnership = {
  kind: 'team',
  teamId: 'team-1',
  teamRunId: 'team-run-1',
  roleId: 'role-1',
  sessionRef: 'agent:main:session-1',
} as const;

const openClawView = sessionView('agent:main:session-1', {
  identity: {
    endpoint,
    agentId: 'main',
    sessionKey: 'agent:main:session-1',
  },
});
const matchaView = sessionView('matcha-session-1', {
  identity: {
    endpoint: matchaEndpoint,
    agentId: 'main',
    sessionKey: 'matcha-session-1',
  },
});

function omitOwnership<T extends { ownership: unknown }>(value: T): Omit<T, 'ownership'> {
  const { ownership: _ownership, ...withoutOwnership } = value;
  void _ownership;
  return withoutOwnership;
}

describe('Electron Main session-create transport', () => {
  it('signs and projects the sealed succeeded outcome', async () => {
    const signDecision = vi.fn().mockReturnValue('signed-decision');
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => openClawView,
    });
    const transport = createSessionCreateTransport({ verificationKey: 'public', signDecision }, 34_101, fetcher);

    await expect(transport.create(request)).resolves.toEqual({
      status: 200,
      body: openClawView,
    });
    expect(signDecision).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: '/api/sessions/create',
      scope: 'sessions:write',
      capability: 'session.prompt',
      subject: 'session-create',
    }));
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:34101/api/sessions/create', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer signed-decision' }),
      body: JSON.stringify(request),
    }));
  });

  it.each([
    ['null', null],
    ['ordinary', ordinaryOwnership],
    ['team', teamOwnership],
  ] as const)('projects the sealed succeeded outcome with %s ownership', async (_name, ownership) => {
    const view = sessionView('agent:main:session-1', {
      identity: {
        endpoint,
        agentId: 'main',
        sessionKey: 'agent:main:session-1',
      },
      ownership,
    });
    const transport = createSessionCreateTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_101,
      vi.fn().mockResolvedValue({ status: 200, json: async () => view }),
    );

    await expect(transport.create(request)).resolves.toEqual({
      status: 200,
      body: view,
    });
  });

  it('accepts the known Matcha native endpoint and preserves its native session key', async () => {
    const signDecision = vi.fn().mockReturnValue('signed-decision');
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => matchaView,
    });
    const transport = createSessionCreateTransport({ verificationKey: 'public', signDecision }, 34_101, fetcher);

    await expect(transport.create(matchaRequest)).resolves.toEqual({
      status: 200,
      body: matchaView,
    });
    expect(signDecision).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:34101/api/sessions/create', expect.objectContaining({
      body: JSON.stringify(matchaRequest),
    }));
  });

  it.each(['target_rejected', 'unknown'] as const)('projects the sealed %s outcome', async (outcome) => {
    const transport = createSessionCreateTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_101,
      vi.fn().mockResolvedValue({ status: 200, json: async () => ({ outcome }) }),
    );

    await expect(transport.create(request)).resolves.toEqual({ status: 200, body: { outcome } });
  });

  it.each([
    { ...request, scope: { ...request.scope, agentId: 'other' } },
    { ...request, target: { ...request.target, agentId: 'other' } },
    { ...request, input: { ...request.input, endpoint: { ...endpoint, runtimeAdapterId: 'unknown-runtime' } } },
    { ...request, input: { ...request.input, endpointSessionId: '' } },
  ])('maps non-local or mismatched requests to fixed unavailable before signing', async (invalid) => {
    const signDecision = vi.fn();
    const fetcher = vi.fn();
    const transport = createSessionCreateTransport({ verificationKey: 'public', signDecision }, 34_101, fetcher);

    await expect(transport.create(invalid)).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Session create is unavailable' },
    });
    expect(signDecision).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ['missing ownership', 200, omitOwnership(openClawView)],
    ['invalid team ownership', 200, { ...openClawView, ownership: { ...teamOwnership, roleId: '' } }],
    ['private native failure', 500, { private: 'native detail' }],
  ])('maps %s to fixed unavailable', async (_name, status, body) => {
    const transport = createSessionCreateTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_101,
      vi.fn().mockResolvedValue({ status, json: async () => body }),
    );

    const response = await transport.create(request);

    expect(response).toEqual({
      status: 503,
      body: { success: false, error: 'Session create is unavailable' },
    });
    expect(JSON.stringify(response)).not.toContain('native detail');
  });
});
