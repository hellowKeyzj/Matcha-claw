import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  invokeIpc,
  invokeIpcWithRetry,
  AppError,
  toUserMessage,
  configureApiClient,
  registerTransportInvoker,
  unregisterTransportInvoker,
  clearTransportBackoff,
  getApiClientConfig,
  applyGatewayTransportPreference,
  createGatewayHttpTransportInvoker,
  createGatewayWsTransportInvoker,
  getGatewayWsDiagnosticEnabled,
  setGatewayWsDiagnosticEnabled,
} from '@/lib/api-client';

class FakeGatewayWebSocket {
  static readonly OPEN = 1;

  readyState = FakeGatewayWebSocket.OPEN;
  sentMessages: Array<Record<string, unknown>> = [];
  private readonly listeners = new Map<string, Set<(event?: unknown) => void>>();

  addEventListener(type: string, listener: (event?: unknown) => void) {
    const current = this.listeners.get(type) ?? new Set();
    current.add(listener);
    this.listeners.set(type, current);
  }

  removeEventListener(type: string, listener: (event?: unknown) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  send(payload: string) {
    this.sentMessages.push(JSON.parse(payload) as Record<string, unknown>);
  }

  emit(type: string, event?: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

describe('api-client', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    window.localStorage.removeItem('clawx:gateway-ws-diagnostic');
    configureApiClient({
      enabled: { ws: false, http: false },
      rules: [{ matcher: /.*/, order: ['ipc'] }],
    });
    clearTransportBackoff();
    unregisterTransportInvoker('ws');
    unregisterTransportInvoker('http');
  });

  it('forwards invoke arguments and returns result', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke.mockResolvedValueOnce({ ok: true });

    const result = await invokeIpc<{ ok: boolean }>('app:version');

    expect(result.ok).toBe(true);
    expect(invoke).toHaveBeenCalledWith('app:version');
  });

  it('normalizes timeout errors', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke.mockRejectedValueOnce(new Error('Gateway Timeout'));

    await expect(invokeIpc('gateway:status')).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('retries once for retryable errors', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke
      .mockRejectedValueOnce(new Error('network timeout'))
      .mockResolvedValueOnce('MatchaClaw');

    const result = await invokeIpcWithRetry<string>('app:name', [], 1);

    expect(result).toBe('MatchaClaw');
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenNthCalledWith(1, 'app:name');
    expect(invoke).toHaveBeenNthCalledWith(2, 'app:name');
  });

  it('returns user-facing message for permission error', () => {
    const msg = toUserMessage(new AppError('PERMISSION', 'forbidden'));
    expect(msg).toContain('Permission denied');
  });

  it('returns user-facing message for auth invalid error', () => {
    const msg = toUserMessage(new AppError('AUTH_INVALID', 'Invalid Authentication'));
    expect(msg).toContain('Authentication failed');
  });

  it('returns user-facing message for channel unavailable error', () => {
    const msg = toUserMessage(new AppError('CHANNEL_UNAVAILABLE', 'Invalid IPC channel'));
    expect(msg).toContain('Service channel unavailable');
  });

  it('sends tuple payload for multi-arg requests', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke.mockResolvedValueOnce({ success: true });

    const result = await invokeIpc<{ success: boolean }>('settings:set', 'language', 'en');

    expect(result.success).toBe(true);
    expect(invoke).toHaveBeenCalledWith('settings:set', 'language', 'en');
  });

  it('uses direct ipc for shell and usage channels', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke
      .mockResolvedValueOnce('MatchaClaw')
      .mockResolvedValueOnce([{ totalTokens: 1 }]);

    await expect(invokeIpc('app:name')).resolves.toEqual('MatchaClaw');
    await expect(invokeIpc('usage:recentTokenHistory', 25)).resolves.toEqual([{ totalTokens: 1 }]);

    expect(invoke).toHaveBeenNthCalledWith(1, 'app:name');
    expect(invoke).toHaveBeenNthCalledWith(2, 'usage:recentTokenHistory', 25);
  });

  it('falls through ws/http and succeeds via ipc when advanced transports fail', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke.mockResolvedValueOnce({ ok: true, data: { ok: true } });

    registerTransportInvoker('ws', async () => {
      throw new Error('ws unavailable');
    });
    registerTransportInvoker('http', async () => {
      throw new Error('http unavailable');
    });
    configureApiClient({
      enabled: { ws: true, http: true },
      rules: [{ matcher: 'gateway:rpc', order: ['ws', 'http', 'ipc'] }],
    });

    const result = await invokeIpc<{ ok: boolean }>('gateway:rpc', 'chat.history', {});
    expect(result.ok).toBe(true);
    expect(invoke).toHaveBeenCalledWith('gateway:rpc', 'chat.history', {});
  });

  it('backs off failed ws transport and skips it on immediate retry', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke.mockResolvedValue({ ok: true });
    const wsInvoker = vi.fn(async () => {
      throw new Error('ws unavailable');
    });

    registerTransportInvoker('ws', wsInvoker);
    configureApiClient({
      enabled: { ws: true, http: false },
      rules: [{ matcher: 'gateway:rpc', order: ['ws', 'ipc'] }],
    });

    await invokeIpc('gateway:rpc', 'chat.history', {});
    await invokeIpc('gateway:rpc', 'chat.history', {});

    expect(wsInvoker).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('retries ws transport after backoff is cleared', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke.mockResolvedValue({ ok: true });
    const wsInvoker = vi.fn(async () => {
      throw new Error('ws unavailable');
    });

    registerTransportInvoker('ws', wsInvoker);
    configureApiClient({
      enabled: { ws: true, http: false },
      rules: [{ matcher: 'gateway:rpc', order: ['ws', 'ipc'] }],
    });

    await invokeIpc('gateway:rpc', 'chat.history', {});
    clearTransportBackoff('ws');
    await invokeIpc('gateway:rpc', 'chat.history', {});

    expect(wsInvoker).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('defaults transport preference to ipc-only', () => {
    applyGatewayTransportPreference();
    const config = getApiClientConfig();
    expect(config.enabled.ws).toBe(false);
    expect(config.enabled.http).toBe(false);
    expect(config.rules[0]).toEqual({ matcher: /^gateway:rpc$/, order: ['ipc'] });
  });

  it('enables ws->http->ipc order when ws diagnostic is on', () => {
    setGatewayWsDiagnosticEnabled(true);
    expect(getGatewayWsDiagnosticEnabled()).toBe(true);

    const config = getApiClientConfig();
    expect(config.enabled.ws).toBe(true);
    expect(config.enabled.http).toBe(true);
    expect(config.rules[0]).toEqual({ matcher: /^gateway:rpc$/, order: ['ws', 'http', 'ipc'] });
  });

  it('parses gateway:httpProxy unified envelope response', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke.mockResolvedValueOnce({
      ok: true,
      data: {
        status: 200,
        ok: true,
        json: { type: 'res', ok: true, payload: { rows: [1, 2] } },
      },
    });

    const invoker = createGatewayHttpTransportInvoker();
    const result = await invoker<{ success: boolean; result: { rows: number[] } }>(
      'gateway:rpc',
      ['chat.history', { sessionKey: 's1' }],
    );

    expect(result.success).toBe(true);
    expect(result.result.rows).toEqual([1, 2]);
    expect(invoke).toHaveBeenCalledWith(
      'gateway:httpProxy',
      expect.objectContaining({
        path: '/rpc',
        method: 'POST',
      }),
    );
  });

  it('throws meaningful error when gateway:httpProxy unified envelope fails', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke.mockResolvedValueOnce({
      ok: false,
      error: { message: 'proxy unavailable' },
    });

    const invoker = createGatewayHttpTransportInvoker();
    await expect(invoker('gateway:rpc', ['chat.history', {}])).rejects.toThrow('proxy unavailable');
  });

  it('gateway ws 握手不会漏掉 open 后立即到达的 challenge 帧', async () => {
    const socket = new FakeGatewayWebSocket();
    const invoker = createGatewayWsTransportInvoker({
      timeoutMs: 200,
      urlResolver: () => 'ws://127.0.0.1:18789/ws',
      tokenResolver: () => 'gw-token',
      websocketFactory: () => socket as unknown as WebSocket,
    });

    const requestPromise = invoker<{ success: boolean; result: { rows: number[] } }>(
      'gateway:rpc',
      ['chat.history', { sessionKey: 's1' }],
    );

    await Promise.resolve();
    socket.emit('open');
    socket.emit('message', {
      data: JSON.stringify({
        type: 'event',
        event: 'connect.challenge',
        payload: { nonce: 'nonce-immediate' },
      }),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const connectMessage = socket.sentMessages.find((message) => message.method === 'connect');
    expect(connectMessage).toBeTruthy();
    expect(connectMessage?.params).toMatchObject({
      client: {
        id: 'webchat-ui',
        displayName: 'MatchaClaw Renderer Diagnostic',
        mode: 'webchat',
      },
    });

    socket.emit('message', {
      data: JSON.stringify({
        type: 'res',
        id: connectMessage?.id,
        ok: true,
        payload: { success: true },
      }),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const requestMessage = socket.sentMessages.find((message) => message.method === 'chat.history');
    expect(requestMessage).toBeTruthy();

    socket.emit('message', {
      data: JSON.stringify({
        type: 'res',
        id: requestMessage?.id,
        ok: true,
        payload: { rows: [1, 2] },
      }),
    });

    await expect(requestPromise).resolves.toEqual({
      success: true,
      result: { rows: [1, 2] },
    });
  });

  it('gateway ws 握手在 control-ui 没有 token 时改走 host settings 读取网关 token', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke
      .mockResolvedValueOnce({ success: true, token: '' })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          status: 200,
          ok: true,
          json: { value: 'gw-token-from-settings' },
        },
      });

    const socket = new FakeGatewayWebSocket();
    const invoker = createGatewayWsTransportInvoker({
      timeoutMs: 200,
      urlResolver: () => 'ws://127.0.0.1:18789/ws',
      websocketFactory: () => socket as unknown as WebSocket,
    });

    const requestPromise = invoker<{ success: boolean; result: { rows: number[] } }>(
      'gateway:rpc',
      ['chat.history', { sessionKey: 's1' }],
    );

    await Promise.resolve();
    socket.emit('open');
    await new Promise((resolve) => setTimeout(resolve, 0));
    socket.emit('message', {
      data: JSON.stringify({
        type: 'event',
        event: 'connect.challenge',
        payload: { nonce: 'nonce-1' },
      }),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(invoke).toHaveBeenNthCalledWith(1, 'gateway:getControlUiUrl');
    expect(invoke).toHaveBeenNthCalledWith(2, 'hostapi:fetch', expect.objectContaining({
      path: '/api/settings/gatewayToken',
      method: 'GET',
    }));

    const connectMessage = socket.sentMessages.find((message) => message.method === 'connect');
    expect(connectMessage).toBeTruthy();
    expect(connectMessage?.params).toMatchObject({
      client: {
        id: 'webchat-ui',
        displayName: 'MatchaClaw Renderer Diagnostic',
        mode: 'webchat',
      },
      auth: { token: 'gw-token-from-settings' },
    });

    socket.emit('message', {
      data: JSON.stringify({
        type: 'res',
        id: connectMessage?.id,
        ok: true,
        payload: { success: true },
      }),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const requestMessage = socket.sentMessages.find((message) => message.method === 'chat.history');
    expect(requestMessage).toBeTruthy();

    socket.emit('message', {
      data: JSON.stringify({
        type: 'res',
        id: requestMessage?.id,
        ok: true,
        payload: { rows: [1, 2] },
      }),
    });

    await expect(requestPromise).resolves.toEqual({
      success: true,
      result: { rows: [1, 2] },
    });
  });
});
