import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

const parseJsonBodyMock = vi.fn();
const sendJsonMock = vi.fn();

vi.mock('../../electron/api/route-utils', () => ({
  parseJsonBody: (...args: unknown[]) => parseJsonBodyMock(...args),
  sendJson: (...args: unknown[]) => sendJsonMock(...args),
}));

describe('peer chat history routes', () => {
  const matchaAgentHistoryTransport = { read: vi.fn() };
  const deps = { matchaAgentHistoryTransport };

  beforeEach(() => {
    vi.clearAllMocks();
  });


  it('forwards malformed Matcha input only to its dedicated transport', async () => {
    parseJsonBodyMock.mockRejectedValue(new Error('invalid JSON'));
    matchaAgentHistoryTransport.read.mockResolvedValue({
      status: 400,
      body: { success: false, error: 'Matcha Agent chat history is unavailable' },
    });
    const { handleChatHistoryRoutes } = await import('../../electron/api/routes/chat-history');
    const response = {} as ServerResponse;

    await expect(handleChatHistoryRoutes(
      { method: 'POST' } as IncomingMessage,
      response,
      new URL('http://127.0.0.1:3210/api/matcha-agent/chat/history'),
      deps,
    )).resolves.toBe(true);

    expect(matchaAgentHistoryTransport.read).toHaveBeenCalledWith(undefined);
    expect(sendJsonMock).toHaveBeenCalledWith(response, 400, {
      success: false,
      error: 'Matcha Agent chat history is unavailable',
    });
  });

  it('does not claim unmatched routes or methods', async () => {
    const { handleChatHistoryRoutes } = await import('../../electron/api/routes/chat-history');

    await expect(handleChatHistoryRoutes(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/other'),
      deps,
    )).resolves.toBe(false);
    await expect(handleChatHistoryRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/other'),
      deps,
    )).resolves.toBe(false);

    expect(matchaAgentHistoryTransport.read).not.toHaveBeenCalled();
  });
});
