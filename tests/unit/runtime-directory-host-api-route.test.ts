import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

const sendJsonMock = vi.fn();

vi.mock('../../electron/api/route-utils', () => ({
  sendJson: (...args: unknown[]) => sendJsonMock(...args),
}));

describe('Runtime endpoint directory Main route', () => {
  it('forwards the sealed directory response', async () => {
    const { handleRuntimeDirectoryRoutes } = await import('../../electron/api/routes/runtime-directory');
    const list = vi.fn().mockResolvedValue({
      status: 200,
      body: { endpoints: [] },
    });
    const response = {} as ServerResponse;

    await expect(handleRuntimeDirectoryRoutes(
      { method: 'GET' } as IncomingMessage,
      response,
      new URL('http://127.0.0.1/api/runtime-endpoints/list'),
      { list },
    )).resolves.toBe(true);

    expect(list).toHaveBeenCalledOnce();
    expect(sendJsonMock).toHaveBeenCalledWith(response, 200, { endpoints: [] });
  });

  it('seals unexpected transport failures as unavailable', async () => {
    const { handleRuntimeDirectoryRoutes } = await import('../../electron/api/routes/runtime-directory');
    const response = {} as ServerResponse;

    await expect(handleRuntimeDirectoryRoutes(
      { method: 'GET' } as IncomingMessage,
      response,
      new URL('http://127.0.0.1/api/runtime-endpoints/list'),
      { list: vi.fn().mockRejectedValue(new Error('private native detail')) },
    )).resolves.toBe(true);

    expect(sendJsonMock).toHaveBeenCalledWith(response, 503, {
      success: false,
      error: 'Runtime endpoint directory is unavailable',
    });
    expect(JSON.stringify(sendJsonMock.mock.calls.at(-1))).not.toContain('private native detail');
  });

  it('does not claim other paths or methods', async () => {
    const { handleRuntimeDirectoryRoutes } = await import('../../electron/api/routes/runtime-directory');
    const list = vi.fn();

    await expect(handleRuntimeDirectoryRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1/api/runtime-endpoints/list'),
      { list },
    )).resolves.toBe(false);
    await expect(handleRuntimeDirectoryRoutes(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1/api/runtime-endpoints/other'),
      { list },
    )).resolves.toBe(false);
    expect(list).not.toHaveBeenCalled();
  });
});
