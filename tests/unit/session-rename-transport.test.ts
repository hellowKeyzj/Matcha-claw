import { describe, expect, it, vi } from 'vitest';
import { createSessionRenameTransport } from '../../electron/main/runtime-host-delivery/transport/sessions/rename';

const endpoint = {
  kind: 'native-runtime',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
} as const;

const identity = {
  endpoint,
  agentId: 'main',
  sessionKey: 'agent:main:demo',
} as const;

const request = {
  id: 'session.management',
  operationId: 'sessions.rename',
  scope: { kind: 'session', identity },
  target: { kind: 'session', identity },
  input: { sessionIdentity: identity, label: 'Renamed' },
} as const;

describe('Electron Main session-rename transport', () => {
  it.each(['succeeded', 'target_rejected', 'unknown'] as const)(
    'signs and projects the sealed %s outcome',
    async (outcome) => {
      const signDecision = vi.fn().mockReturnValue('signed-decision');
      const fetcher = vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({ outcome }),
      });
      const transport = createSessionRenameTransport({ verificationKey: 'public', signDecision }, 34_101, fetcher);

      await expect(transport.rename(request)).resolves.toEqual({
        status: 200,
        body: { outcome },
      });
      expect(signDecision).toHaveBeenCalledWith(expect.objectContaining({
        endpoint: '/api/sessions/rename',
        scope: 'sessions:write',
        capability: 'sessions.rename',
        subject: 'session-rename',
      }));
      expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:34101/api/sessions/rename', expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer signed-decision' }),
        body: JSON.stringify(request),
      }));
    },
  );

  it.each([
    { ...request, scope: { ...request.scope, identity: { ...identity, sessionKey: 'agent:main:other' } } },
    { ...request, target: { ...request.target, identity: { ...identity, agentId: 'other' } } },
    { ...request, input: { ...request.input, sessionIdentity: { ...identity, endpoint: { ...endpoint, runtimeAdapterId: 'matcha-agent' } } } },
    { ...request, input: { ...request.input, label: '   ' } },
    { ...request, operationId: 'sessions.archive' },
  ])('maps non-local, mismatched, or invalid requests to fixed unavailable before signing', async (invalid) => {
    const signDecision = vi.fn();
    const fetcher = vi.fn();
    const transport = createSessionRenameTransport({ verificationKey: 'public', signDecision }, 34_101, fetcher);

    await expect(transport.rename(invalid)).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Session rename is unavailable' },
    });
    expect(signDecision).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('maps private native failures and malformed DTOs to fixed unavailable', async () => {
    const transport = createSessionRenameTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_101,
      vi.fn().mockResolvedValue({
        status: 500,
        json: async () => ({ private: 'native detail' }),
      }),
    );

    const response = await transport.rename(request);

    expect(response).toEqual({
      status: 503,
      body: { success: false, error: 'Session rename is unavailable' },
    });
    expect(JSON.stringify(response)).not.toContain('native detail');
  });
});
