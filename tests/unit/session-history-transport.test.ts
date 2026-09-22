import { describe, expect, it, vi } from 'vitest';
import { createSessionHistoryTransport } from '../../electron/main/runtime-host-delivery/transport/sessions/history';

const sessionIdentity = {
  endpoint: {
    kind: 'native-runtime',
    runtimeAdapterId: 'matcha-agent',
    runtimeInstanceId: 'local',
  },
  agentId: 'matcha-agent',
  sessionKey: 'matcha-session-1',
} as const;

const request = {
  id: 'session.management',
  operationId: 'sessions.history',
  scope: { kind: 'session', identity: sessionIdentity },
  target: { kind: 'session', identity: sessionIdentity },
  input: {
    sessionKey: 'matcha-session-1',
    sessionIdentity,
    endpointSessionId: 'native-session-1',
    limit: 20,
  },
} as const;

const issuer = {
  signDecision: vi.fn(() => 'signed-capability'),
  verificationKey: 'verification-key',
};

describe('Electron Main session history transport', () => {
  it('signs and strictly proxies the native text history response', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ messages: [{ role: 'assistant', text: 'Reply' }] }),
    });
    const transport = createSessionHistoryTransport(issuer, 32_144, fetcher);

    await expect(transport.read(request)).resolves.toEqual({
      status: 200,
      body: { messages: [{ role: 'assistant', text: 'Reply' }] },
    });
    expect(issuer.signDecision).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: '/api/sessions/history',
      scope: 'sessions:read',
      capability: 'session.management',
      subject: 'session-history',
    }));
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:32144/api/sessions/history',
      expect.objectContaining({ body: JSON.stringify(request) }),
    );
  });

  it('rejects malformed requests without calling the loopback owner', async () => {
    const fetcher = vi.fn();
    const transport = createSessionHistoryTransport(issuer, 32_144, fetcher);

    await expect(transport.read({ ...request, eventStore: true })).resolves.toEqual({
      status: 400,
      body: { success: false, error: 'Session history is unavailable' },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('redacts malformed native responses and transport failures', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce({
        status: 200,
        json: async () => ({ messages: [{ role: 'assistant', text: 'Reply', raw: 'private' }] }),
      })
      .mockRejectedValueOnce(new Error('private loopback failure'));
    const transport = createSessionHistoryTransport(issuer, 32_144, fetcher);

    await expect(transport.read(request)).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Session history is unavailable' },
    });
    await expect(transport.read(request)).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Session history is unavailable' },
    });
  });
});
