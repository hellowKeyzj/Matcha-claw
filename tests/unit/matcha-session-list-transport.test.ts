import { describe, expect, it, vi } from 'vitest';
import { createMatchaSessionListTransport } from '../../electron/main/runtime-host-delivery/transport/sessions/matcha-list';

const endpoint = {
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
const catalog = {
  sessions: [{
    endpoint,
    nativeSessionHandle: 'native-session-1',
    updatedAt: 1_728_000_000_000,
  }],
} as const;
const unavailable = {
  success: false,
  error: 'Matcha session catalog is unavailable',
};

describe('Electron Main Matcha session catalog transport', () => {
  it('sends the sealed request and fixed authorization decision', async () => {
    const signDecision = vi.fn().mockReturnValue('signed-matcha-decision');
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => catalog,
    });
    const transport = createMatchaSessionListTransport(
      { verificationKey: 'public', signDecision },
      34_101,
      fetcher,
    );

    await expect(transport.list(request)).resolves.toEqual({
      status: 200,
      body: {
        sessions: [{
          key: 'matcha-agent:matcha:native-session-1',
          agentId: 'matcha',
          sessionIdentity: {
            endpoint,
            agentId: 'matcha',
            sessionKey: 'matcha-agent:matcha:native-session-1',
          },
          kind: 'session',
          preferred: false,
          endpointSessionId: 'native-session-1',
          protocolId: 'matcha-agent-app-server',
          runtimeEndpointId: 'matcha-agent-local',
          updatedAt: 1_728_000_000_000,
        }],
      },
    });
    expect(signDecision).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: '/api/matcha/sessions',
      scope: 'sessions:read',
      capability: 'sessions.list',
      subject: 'matcha-session-catalog',
    }));
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:34101/api/matcha/sessions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer signed-matcha-decision',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });
  });

  it.each([
    { ...request, target: { kind: 'runtime-endpoint', endpoint } },
    { ...request, input: { endpoint: { ...endpoint, runtimeInstanceId: 'remote' } } },
    { ...request, scope: { ...request.scope, endpoint: { ...endpoint, runtimeAdapterId: 'openclaw' } } },
  ])('rejects non-exact Matcha requests before authorization', async (invalidRequest) => {
    const signDecision = vi.fn();
    const fetcher = vi.fn();
    const transport = createMatchaSessionListTransport(
      { verificationKey: 'public', signDecision },
      34_101,
      fetcher,
    );

    await expect(transport.list(invalidRequest)).resolves.toEqual({ status: 503, body: unavailable });
    expect(signDecision).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { sessions: [{ endpoint, nativeSessionHandle: 'native-session-1', unknown: true }] },
    { sessions: [{ endpoint, nativeSessionHandle: '' }] },
    { sessions: [{ endpoint, nativeSessionHandle: 'native-session-1', updatedAt: 'now' }] },
    { sessions: [{ endpoint: { ...endpoint, runtimeAdapterId: 'openclaw' }, nativeSessionHandle: 'native-session-1' }] },
  ])('redacts malformed native catalog DTOs', async (body) => {
    const transport = createMatchaSessionListTransport(
      { verificationKey: 'public', signDecision: () => 'signed-matcha-decision' },
      34_101,
      vi.fn().mockResolvedValue({ status: 200, json: async () => body }),
    );

    await expect(transport.list(request)).resolves.toEqual({ status: 503, body: unavailable });
  });

  it('redacts transport and non-success response details', async () => {
    const transport = createMatchaSessionListTransport(
      { verificationKey: 'public', signDecision: () => 'signed-matcha-decision' },
      34_101,
      vi.fn().mockRejectedValue(new Error('private native token')),
    );

    const response = await transport.list(request);
    expect(response).toEqual({ status: 503, body: unavailable });
    expect(JSON.stringify(response)).not.toContain('private native token');
  });
});
