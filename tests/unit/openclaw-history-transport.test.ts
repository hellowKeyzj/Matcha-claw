import { describe, expect, it, vi } from 'vitest';
import { createOpenClawHistoryTransport } from '../../electron/main/runtime-host-delivery/transport/sessions/openclaw-history';

const request = {
  id: 'openclaw.chat.history',
  operationId: 'openclaw.chat.history',
  sessionKey: 'agent:main:demo',
} as const;

describe('Electron Main OpenClaw history transport', () => {
  it('signs the fixed text-only history request and projects only role/text', async () => {
    const signDecision = vi.fn().mockReturnValue('signed-decision');
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ messages: [{ role: 'assistant', text: 'Reply' }] }),
    });
    const transport = createOpenClawHistoryTransport({ verificationKey: 'public', signDecision }, 34_219, fetcher);

    await expect(transport.read(request)).resolves.toEqual({
      status: 200,
      body: { messages: [{ role: 'assistant', text: 'Reply' }] },
    });
    expect(signDecision).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: '/api/openclaw/chat/history',
      scope: 'openclaw:chat-history:read',
      capability: 'openclaw.chat.history',
      subject: 'openclaw-chat-history',
    }));
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:34219/api/openclaw/chat/history',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(request) }),
    );
  });

  it('fails closed before signing malformed requests and redacts native failures', async () => {
    const signDecision = vi.fn();
    const fetcher = vi.fn();
    const transport = createOpenClawHistoryTransport({ verificationKey: 'public', signDecision }, 34_219, fetcher);

    await expect(transport.read({ ...request, raw: 'private' })).resolves.toEqual({
      status: 400,
      body: { success: false, error: 'OpenClaw chat history is unavailable' },
    });
    expect(signDecision).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();

    const unavailable = await createOpenClawHistoryTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_219,
      vi.fn().mockRejectedValue(new Error('private gateway failure')),
    ).read(request);
    expect(unavailable).toEqual({
      status: 503,
      body: { success: false, error: 'OpenClaw chat history is unavailable' },
    });
    expect(JSON.stringify(unavailable)).not.toContain('private gateway failure');
  });
});
