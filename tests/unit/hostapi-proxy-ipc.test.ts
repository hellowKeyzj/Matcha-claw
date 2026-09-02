import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handlers,
    ipcMainHandleMock: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
    proxyAwareFetchMock: vi.fn(),
    getHostApiBaseUrlMock: vi.fn(() => 'http://127.0.0.1:13210'),
    getHostApiTokenMock: vi.fn(() => 'host-api-token'),
    waitForHostApiReadyMock: vi.fn(async () => undefined),
    handleE2EHostApiFetchMock: vi.fn(),
  };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: (...args: unknown[]) => hoisted.ipcMainHandleMock(...args),
  },
}));
vi.mock('../../electron/utils/proxy-fetch', () => ({
  proxyAwareFetch: (...args: unknown[]) => hoisted.proxyAwareFetchMock(...args),
}));
vi.mock('../../electron/api/server', () => ({
  getHostApiBaseUrl: () => hoisted.getHostApiBaseUrlMock(),
  getHostApiToken: () => hoisted.getHostApiTokenMock(),
  waitForHostApiReady: () => hoisted.waitForHostApiReadyMock(),
}));
vi.mock('../../electron/main/e2e-fixture-loader', () => ({
  handleE2EHostApiFetch: (...args: unknown[]) => hoisted.handleE2EHostApiFetchMock(...args),
}));

describe('host API IPC boundary', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.clearAllMocks();
    hoisted.handlers.clear();
    hoisted.getHostApiBaseUrlMock.mockReturnValue('http://127.0.0.1:13210');
    hoisted.getHostApiTokenMock.mockReturnValue('host-api-token');
    hoisted.waitForHostApiReadyMock.mockResolvedValue(undefined);
    hoisted.handleE2EHostApiFetchMock.mockResolvedValue(null);
  });

  it.each([
    ['GET', '/api/logs'],
    ['GET', '/api/logs/dir'],
    ['GET', '/api/logs/files'],
    ['GET', '/api/openclaw/logs'],
    ['GET', '/api/openclaw/logs/dir'],
    ['GET', '/api/gateway/status'],
    ['GET', '/api/gateway/health'],
    ['POST', '/api/gateway/start'],
    ['POST', '/api/gateway/stop'],
    ['POST', '/api/gateway/restart'],
    ['GET', '/api/gateway/control-ui'],
    ['POST', '/api/runtime-host/restart'],
  ])('forwards retained public route %s %s', async (method, path) => {
    hoisted.proxyAwareFetchMock.mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: vi.fn(async () => ({ success: true })),
    });
    const { registerHostApiProxyHandlers } = await import('../../electron/main/ipc/hostapi-proxy-ipc');
    registerHostApiProxyHandlers();

    const handler = hoisted.handlers.get('hostapi:fetch');
    await handler?.({}, { path, method });

    expect(hoisted.proxyAwareFetchMock).toHaveBeenCalledWith(
      `http://127.0.0.1:13210${path}`,
      expect.objectContaining({ method }),
    );
  });

  it.each([
    ['POST', '/api/openclaw/logs'],
    ['POST', '/api/gateway/status'],
    ['GET', '/api/gateway/restart'],
    ['GET', '/api/runtime-host/restart'],
    ['POST', '/internal/runtime-host/shell-actions'],
  ])('rejects unsupported public method or internal path %s %s before any loopback request', async (method, path) => {
    const { registerHostApiProxyHandlers } = await import('../../electron/main/ipc/hostapi-proxy-ipc');
    registerHostApiProxyHandlers();

    const handler = hoisted.handlers.get('hostapi:fetch');
    const result = await handler?.({}, { path, method });

    expect(result).toEqual({
      ok: false,
      error: { message: 'Host API request is unavailable.', code: 'UNAVAILABLE' },
    });
    expect(hoisted.proxyAwareFetchMock).not.toHaveBeenCalled();
  });

  it('forwards retained diagnostics requests with host-only credentials', async () => {
    hoisted.proxyAwareFetchMock.mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: vi.fn(async () => ({ sampledAt: 'now' })),
    });
    const { registerHostApiProxyHandlers } = await import('../../electron/main/ipc/hostapi-proxy-ipc');
    registerHostApiProxyHandlers();

    const handler = hoisted.handlers.get('hostapi:fetch');
    const result = await handler?.({}, {
      path: '/api/diagnostics/memory',
      method: 'GET',
      headers: {
        authorization: 'Bearer renderer-token',
        'Proxy-Authorization': 'Basic renderer-credential',
        'X-Request-Source': 'renderer',
      },
    });

    expect(result).toEqual({
      ok: true,
      data: { status: 200, ok: true, json: { sampledAt: 'now' } },
    });
    expect(hoisted.proxyAwareFetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:13210/api/diagnostics/memory',
      expect.objectContaining({
        method: 'GET',
        headers: {
          Authorization: 'Bearer host-api-token',
          'X-Request-Source': 'renderer',
        },
      }),
    );
  });

  it('waits for Host API readiness before reading loopback credentials', async () => {
    let resolveReady!: () => void;
    hoisted.waitForHostApiReadyMock.mockReturnValue(new Promise<void>((resolve) => { resolveReady = resolve; }));
    hoisted.proxyAwareFetchMock.mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: vi.fn(async () => ({ ready: true })),
    });
    const { registerHostApiProxyHandlers } = await import('../../electron/main/ipc/hostapi-proxy-ipc');
    registerHostApiProxyHandlers();

    const handler = hoisted.handlers.get('hostapi:fetch');
    const resultPromise = handler?.({}, {
      path: '/api/diagnostics/memory',
      method: 'GET',
    });
    await Promise.resolve();

    expect(hoisted.waitForHostApiReadyMock).toHaveBeenCalledOnce();
    expect(hoisted.getHostApiBaseUrlMock).not.toHaveBeenCalled();
    expect(hoisted.getHostApiTokenMock).not.toHaveBeenCalled();
    expect(hoisted.proxyAwareFetchMock).not.toHaveBeenCalled();

    resolveReady();
    const result = await resultPromise;

    expect(result).toEqual({
      ok: true,
      data: { status: 200, ok: true, json: { ready: true } },
    });
    expect(hoisted.proxyAwareFetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:13210/api/diagnostics/memory',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('classifies renderer abort while waiting for Host API readiness', async () => {
    hoisted.waitForHostApiReadyMock.mockReturnValue(new Promise<void>(() => undefined));
    const { registerHostApiProxyHandlers } = await import('../../electron/main/ipc/hostapi-proxy-ipc');
    registerHostApiProxyHandlers();

    const fetchHandler = hoisted.handlers.get('hostapi:fetch');
    const abortHandler = hoisted.handlers.get('hostapi:abort');
    const resultPromise = fetchHandler?.({}, {
      requestId: 'request-before-ready',
      path: '/api/diagnostics/memory',
      method: 'GET',
    });
    await Promise.resolve();

    const abortResult = await abortHandler?.({}, { requestId: 'request-before-ready' });
    const result = await resultPromise;

    expect(abortResult).toEqual({ ok: true });
    expect(result).toEqual({
      ok: false,
      error: { message: 'Host API request is unavailable.', code: 'ABORTED' },
    });
    expect(hoisted.proxyAwareFetchMock).not.toHaveBeenCalled();
  });

  it('classifies timeout while waiting for Host API readiness', async () => {
    vi.useFakeTimers();
    hoisted.waitForHostApiReadyMock.mockReturnValue(new Promise<void>(() => undefined));
    const { registerHostApiProxyHandlers } = await import('../../electron/main/ipc/hostapi-proxy-ipc');
    registerHostApiProxyHandlers();

    const handler = hoisted.handlers.get('hostapi:fetch');
    const resultPromise = handler?.({}, {
      path: '/api/diagnostics/memory',
      method: 'GET',
      timeoutMs: 10,
    });
    await vi.advanceTimersByTimeAsync(10);
    const result = await resultPromise;

    expect(result).toEqual({
      ok: false,
      error: { message: 'Host API request is unavailable.', code: 'TIMEOUT' },
    });
    expect(hoisted.proxyAwareFetchMock).not.toHaveBeenCalled();
  });

  it('rejects unimplemented methods before the proxy request', async () => {
    const { registerHostApiProxyHandlers } = await import('../../electron/main/ipc/hostapi-proxy-ipc');
    registerHostApiProxyHandlers();

    const handler = hoisted.handlers.get('hostapi:fetch');
    const result = await handler?.({}, {
      path: '/api/diagnostics/memory',
      method: 'POST',
    });

    expect(result).toEqual({
      ok: false,
      error: { message: 'Host API request is unavailable.', code: 'UNAVAILABLE' },
    });
    expect(hoisted.proxyAwareFetchMock).not.toHaveBeenCalled();
  });

  it('does not expose upstream errors through the renderer IPC envelope', async () => {
    hoisted.proxyAwareFetchMock.mockRejectedValue(
      new Error('upstream rejected Authorization: Bearer private-token at /private/native/path'),
    );
    const { registerHostApiProxyHandlers } = await import('../../electron/main/ipc/hostapi-proxy-ipc');
    registerHostApiProxyHandlers();

    const handler = hoisted.handlers.get('hostapi:fetch');
    const result = await handler?.({}, {
      path: '/api/diagnostics/memory',
      method: 'GET',
    });

    expect(result).toEqual({
      ok: false,
      error: { message: 'Host API request is unavailable.', code: 'UNAVAILABLE' },
    });
    expect(JSON.stringify(result)).not.toContain('private-token');
    expect(JSON.stringify(result)).not.toContain('/private/native/path');
  });

  it('classifies upstream timeout without exposing raw error details', async () => {
    vi.useFakeTimers();
    hoisted.proxyAwareFetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      (init as { signal: AbortSignal }).signal.addEventListener('abort', () => reject(new Error('raw timeout /private/native/path')));
    }));
    const { registerHostApiProxyHandlers } = await import('../../electron/main/ipc/hostapi-proxy-ipc');
    registerHostApiProxyHandlers();

    const handler = hoisted.handlers.get('hostapi:fetch');
    const resultPromise = handler?.({}, {
      path: '/api/diagnostics/memory',
      method: 'GET',
      timeoutMs: 10,
    });
    await vi.advanceTimersByTimeAsync(10);
    const result = await resultPromise;

    expect(result).toEqual({
      ok: false,
      error: { message: 'Host API request is unavailable.', code: 'TIMEOUT' },
    });
    expect(JSON.stringify(result)).not.toContain('/private/native/path');
  });

  it('classifies renderer abort without exposing raw error details', async () => {
    hoisted.proxyAwareFetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      (init as { signal: AbortSignal }).signal.addEventListener('abort', () => reject(new Error('raw abort /private/native/path')));
    }));
    const { registerHostApiProxyHandlers } = await import('../../electron/main/ipc/hostapi-proxy-ipc');
    registerHostApiProxyHandlers();

    const fetchHandler = hoisted.handlers.get('hostapi:fetch');
    const abortHandler = hoisted.handlers.get('hostapi:abort');
    const resultPromise = fetchHandler?.({}, {
      requestId: 'request-1',
      path: '/api/diagnostics/memory',
      method: 'GET',
    });
    await Promise.resolve();
    const abortResult = await abortHandler?.({}, { requestId: 'request-1' });
    const result = await resultPromise;

    expect(abortResult).toEqual({ ok: true });
    expect(result).toEqual({
      ok: false,
      error: { message: 'Host API request is unavailable.', code: 'ABORTED' },
    });
    expect(JSON.stringify(result)).not.toContain('/private/native/path');
  });
});
