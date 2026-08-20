import { describe, expect, it, vi } from 'vitest';
import { createMatchaAgentHistoryTransport } from '../../electron/main/runtime-host-delivery/transport/sessions/matcha-history';

const request = {
  id: 'matcha-agent.chat.history',
  operationId: 'matcha-agent.chat.history',
  sessionId: 'matcha-session-1',
} as const;

const issuer = {
  signDecision: vi.fn(() => 'signed-capability'),
  verificationKey: 'verification-key',
};

describe('Electron Main Matcha Agent history transport', () => {
  it('signs and strictly proxies the native text history response', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ messages: [{ role: 'assistant', text: 'Reply' }] }),
    });
    const transport = createMatchaAgentHistoryTransport(issuer, 32_144, fetcher);

    await expect(transport.read(request)).resolves.toEqual({
      status: 200,
      body: { messages: [{ role: 'assistant', text: 'Reply' }] },
    });
    expect(issuer.signDecision).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: '/api/matcha-agent/chat/history',
      scope: 'matcha-agent:chat-history:read',
      capability: 'matcha-agent.chat.history',
      subject: 'matcha-agent-chat-history',
    }));
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:32144/api/matcha-agent/chat/history',
      expect.objectContaining({ body: JSON.stringify(request) }),
    );
  });

  it('rejects malformed requests without calling the loopback owner', async () => {
    const fetcher = vi.fn();
    const transport = createMatchaAgentHistoryTransport(issuer, 32_144, fetcher);

    await expect(transport.read({ ...request, eventStore: true })).resolves.toEqual({
      status: 400,
      body: { success: false, error: 'Matcha Agent chat history is unavailable' },
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
    const transport = createMatchaAgentHistoryTransport(issuer, 32_144, fetcher);

    await expect(transport.read(request)).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Matcha Agent chat history is unavailable' },
    });
    await expect(transport.read(request)).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Matcha Agent chat history is unavailable' },
    });
  });
});
