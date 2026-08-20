import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

const sendJsonMock = vi.fn();

vi.mock('../../electron/api/route-utils', () => ({
  sendJson: (...args: unknown[]) => sendJsonMock(...args),
}));

describe('Runtime Host usage legacy route', () => {
  it('projects the sealed entries envelope to the legacy array DTO', async () => {
    const { handleRuntimeHostUsageRoutes } = await import('../../electron/api/routes/runtime-host-usage');
    const entries = [{
      sessionId: 'session-1',
      agentId: 'main',
      timestamp: '2026-08-07T10:00:00.000Z',
      model: 'model',
      provider: 'provider',
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      totalTokens: 10,
      costUsd: 0.01,
    }];
    const read = vi.fn().mockResolvedValue({ status: 200, body: { entries } });
    const response = {} as ServerResponse;

    await expect(handleRuntimeHostUsageRoutes(
      { method: 'GET' } as IncomingMessage,
      response,
      new URL('http://127.0.0.1/api/runtime-host/usage/recent?limit=25'),
      { read },
    )).resolves.toBe(true);

    expect(read).toHaveBeenCalledWith(25);
    expect(sendJsonMock).toHaveBeenCalledWith(response, 200, entries);
  });

  it('preserves the sealed transport error projection', async () => {
    const { handleRuntimeHostUsageRoutes } = await import('../../electron/api/routes/runtime-host-usage');
    const body = { success: false, error: 'OpenClaw usage history is unavailable' } as const;
    const read = vi.fn().mockResolvedValue({ status: 503, body });
    const response = {} as ServerResponse;

    await expect(handleRuntimeHostUsageRoutes(
      { method: 'GET' } as IncomingMessage,
      response,
      new URL('http://127.0.0.1/api/runtime-host/usage/recent'),
      { read },
    )).resolves.toBe(true);

    expect(sendJsonMock).toHaveBeenCalledWith(response, 503, body);
  });

  it('passes malformed limits to the sealed transport', async () => {
    const { handleRuntimeHostUsageRoutes } = await import('../../electron/api/routes/runtime-host-usage');
    const read = vi.fn().mockResolvedValue({
      status: 400,
      body: { success: false, error: 'OpenClaw usage history is unavailable' },
    });

    await expect(handleRuntimeHostUsageRoutes(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1/api/runtime-host/usage/recent?limit=not-a-number'),
      { read },
    )).resolves.toBe(true);

    expect(read).toHaveBeenCalledWith(Number.NaN);
  });

  it('does not claim other paths or methods', async () => {
    const { handleRuntimeHostUsageRoutes } = await import('../../electron/api/routes/runtime-host-usage');
    const read = vi.fn();

    await expect(handleRuntimeHostUsageRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1/api/runtime-host/usage/recent'),
      { read },
    )).resolves.toBe(false);
    await expect(handleRuntimeHostUsageRoutes(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1/api/usage/recent'),
      { read },
    )).resolves.toBe(false);
    expect(read).not.toHaveBeenCalled();
  });
});
