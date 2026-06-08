import { beforeEach, describe, expect, it, vi } from 'vitest';

const registeredHandlers = new Map<string, (...args: unknown[]) => unknown>();
const proxyAwareFetchMock = vi.fn();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      registeredHandlers.set(channel, handler);
    },
  },
}));

vi.mock('../../electron/utils/proxy-fetch', () => ({
  proxyAwareFetch: (...args: unknown[]) => proxyAwareFetchMock(...args),
}));

vi.mock('../../electron/utils/config', () => ({
  getPort: vi.fn(() => 13210),
}));

vi.mock('../../electron/api/server', () => ({
  getHostApiToken: vi.fn(() => 'host-token'),
}));

vi.mock('../../electron/main/e2e-fixture-loader', () => ({
  handleE2EHostApiFetch: vi.fn(async () => null),
}));

describe('hostapi proxy ipc', () => {
  beforeEach(() => {
    vi.resetModules();
    registeredHandlers.clear();
    proxyAwareFetchMock.mockReset();
    proxyAwareFetchMock.mockResolvedValue({
      status: 200,
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ success: true }),
      text: async () => 'ok',
    });
  });

  async function fetchViaProxy(request: Record<string, unknown>) {
    const { registerHostApiProxyHandlers } = await import('../../electron/main/ipc/hostapi-proxy-ipc');
    registerHostApiProxyHandlers();
    const handler = registeredHandlers.get('hostapi:fetch');
    expect(handler).toBeTypeOf('function');
    return await handler?.({}, request);
  }

  it('forwards allowed capability calls with host token', async () => {
    const result = await fetchViaProxy({ path: '/api/capabilities/execute', method: 'POST', body: { id: 'workspace.file' } });

    expect(result).toMatchObject({ ok: true, data: { status: 200, ok: true } });
    expect(proxyAwareFetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:13210/api/capabilities/execute',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer host-token' }),
        body: JSON.stringify({ id: 'workspace.file' }),
      }),
    );
  });

  it('forwards explicit public read-only routes including query strings', async () => {
    await fetchViaProxy({ path: '/api/logs?tailLines=10', method: 'GET' });

    expect(proxyAwareFetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:13210/api/logs?tailLines=10',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('rejects legacy file routes, secret routes, mutations, internal routes, and absolute URLs before forwarding', async () => {
    for (const request of [
      { path: '/api/files/read-text', method: 'POST' },
      { path: '/api/files/write-text', method: 'POST' },
      { path: '/api/provider-accounts/account-1/api-key', method: 'GET' },
      { path: '/api/provider-accounts/validate', method: 'POST' },
      { path: '/api/gateway/start', method: 'POST' },
      { path: '/api/runtime-host/restart', method: 'POST' },
      { path: '/internal/runtime-host/shell-actions', method: 'POST' },
      { path: 'http://127.0.0.1:13210/api/capabilities/list', method: 'GET' },
    ]) {
      const result = await fetchViaProxy(request);
      expect(result).toMatchObject({ ok: false });
    }

    expect(proxyAwareFetchMock).not.toHaveBeenCalled();
  });
});
