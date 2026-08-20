import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

const sendJsonMock = vi.fn();

vi.mock('../../electron/api/route-utils', () => ({
  sendJson: (...args: unknown[]) => sendJsonMock(...args),
}));

describe('Usage Host API route', () => {
  it('forwards the optional numeric limit to the dedicated transport', async () => {
    const { handleUsageRoutes } = await import('../../electron/api/routes/usage');
    const read = vi.fn().mockResolvedValue({ status: 200, body: { entries: [] } });
    const response = {} as ServerResponse;

    await expect(handleUsageRoutes(
      { method: 'GET' } as IncomingMessage,
      response,
      new URL('http://127.0.0.1/api/usage/recent?limit=25'),
      { read },
    )).resolves.toBe(true);

    expect(read).toHaveBeenCalledWith(25);
    expect(sendJsonMock).toHaveBeenCalledWith(response, 200, { entries: [] });
  });

  it('forwards a malformed limit unchanged so the sealed transport rejects it', async () => {
    const { handleUsageRoutes } = await import('../../electron/api/routes/usage');
    const read = vi.fn().mockResolvedValue({
      status: 400,
      body: { success: false, error: 'OpenClaw usage history is unavailable' },
    });
    const response = {} as ServerResponse;

    await expect(handleUsageRoutes(
      { method: 'GET' } as IncomingMessage,
      response,
      new URL('http://127.0.0.1/api/usage/recent?limit=not-a-number'),
      { read },
    )).resolves.toBe(true);

    expect(read).toHaveBeenCalledWith(Number.NaN);
    expect(sendJsonMock).toHaveBeenCalledWith(response, 400, {
      success: false,
      error: 'OpenClaw usage history is unavailable',
    });
  });

  it('does not claim other paths or methods', async () => {
    const { handleUsageRoutes } = await import('../../electron/api/routes/usage');
    const read = vi.fn();

    await expect(handleUsageRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1/api/usage/recent'),
      { read },
    )).resolves.toBe(false);
    await expect(handleUsageRoutes(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1/api/usage/other'),
      { read },
    )).resolves.toBe(false);
    expect(read).not.toHaveBeenCalled();
  });
});
