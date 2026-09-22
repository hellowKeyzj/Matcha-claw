import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

const parseJsonBodyMock = vi.fn();
const sendJsonMock = vi.fn();

vi.mock('../../electron/api/route-utils', () => ({
  parseJsonBody: (...args: unknown[]) => parseJsonBodyMock(...args),
  sendJson: (...args: unknown[]) => sendJsonMock(...args),
}));

describe('session history routes', () => {
  const sessionHistoryTransport = { read: vi.fn() };
  const deps = { runtimeHostTransports: { sessionHistoryTransport } };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards malformed input only to its dedicated transport', async () => {
    parseJsonBodyMock.mockRejectedValue(new Error('invalid JSON'));
    sessionHistoryTransport.read.mockResolvedValue({
      status: 400,
      body: { success: false, error: 'Session history is unavailable' },
    });
    const { handleSessionHistoryRoutes } = await import('../../electron/api/routes/session-history');
    const response = {} as ServerResponse;

    await expect(handleSessionHistoryRoutes(
      { method: 'POST' } as IncomingMessage,
      response,
      new URL('http://127.0.0.1:3210/api/sessions/history'),
      deps,
    )).resolves.toBe(true);

    expect(sessionHistoryTransport.read).toHaveBeenCalledWith(undefined);
    expect(sendJsonMock).toHaveBeenCalledWith(response, 400, {
      success: false,
      error: 'Session history is unavailable',
    });
  });

  it('does not claim unmatched routes or methods', async () => {
    const { handleSessionHistoryRoutes } = await import('../../electron/api/routes/session-history');

    await expect(handleSessionHistoryRoutes(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/other'),
      deps,
    )).resolves.toBe(false);
    await expect(handleSessionHistoryRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/other'),
      deps,
    )).resolves.toBe(false);

    expect(sessionHistoryTransport.read).not.toHaveBeenCalled();
  });
});
