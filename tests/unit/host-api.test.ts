import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeIpcMock = vi.fn();

vi.mock('@/lib/api-client', () => ({
  invokeIpc: (...args: unknown[]) => invokeIpcMock(...args),
}));

describe('host-api', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('uses IPC proxy and returns unified envelope json', async () => {
    invokeIpcMock.mockResolvedValueOnce({
      ok: true,
      data: {
        status: 200,
        ok: true,
        json: { success: true },
      },
    });

    const { hostApiFetch } = await import('@/lib/host-api');
    const result = await hostApiFetch<{ success: boolean }>('/api/settings');

    expect(result.success).toBe(true);
    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({ path: '/api/settings', method: 'GET' }),
    );
  });

  it('throws message from unified non-ok envelope', async () => {
    invokeIpcMock.mockResolvedValueOnce({
      ok: false,
      error: { message: 'Invalid Authentication' },
    });

    const { hostApiFetch } = await import('@/lib/host-api');
    await expect(hostApiFetch('/api/test')).rejects.toThrow('Invalid Authentication');
  });

  it('throws when host api returns http error status in proxy envelope', async () => {
    invokeIpcMock.mockResolvedValueOnce({
      ok: true,
      data: {
        status: 500,
        ok: false,
        json: { success: false, error: 'Runtime Host HTTP request failed: GET /api/cron/jobs (fetch failed)' },
      },
    });

    const { hostApiFetch } = await import('@/lib/host-api');
    await expect(hostApiFetch('/api/cron/jobs')).rejects.toThrow(
      'Runtime Host HTTP request failed: GET /api/cron/jobs (fetch failed)',
    );
  });

  it('rejects malformed success envelope when status is missing', async () => {
    invokeIpcMock.mockResolvedValueOnce({
      ok: true,
      data: {
        ok: false,
        json: { message: 'logical failed' },
      },
    });

    const { hostApiFetch } = await import('@/lib/host-api');
    await expect(hostApiFetch('/api/cron/jobs')).rejects.toThrow('missing numeric status');
  });

  it('rejects legacy envelope schema', async () => {
    invokeIpcMock.mockResolvedValueOnce({
      success: true,
      status: 200,
      json: { value: 1 },
    });

    const { hostApiFetch } = await import('@/lib/host-api');
    await expect(hostApiFetch('/api/test')).rejects.toThrow('missing boolean ok');
  });

  it('does not fall back to browser fetch when IPC channel is unavailable', async () => {
    invokeIpcMock.mockRejectedValueOnce(new Error('Invalid IPC channel: hostapi:fetch'));

    const { hostApiFetch } = await import('@/lib/host-api');
    await expect(hostApiFetch('/api/test')).rejects.toThrow('Invalid IPC channel: hostapi:fetch');
  });

  it('hostGatewayRequest 默认使用统一的 gateway RPC 超时预算', async () => {
    invokeIpcMock.mockResolvedValueOnce({
      ok: true,
      data: {
        status: 200,
        ok: true,
        json: { success: true, result: { value: 1 } },
      },
    });

    const { hostGatewayRequest } = await import('@/lib/host-api');
    const result = await hostGatewayRequest<{ value: number }>('models.list', {});

    expect(result).toEqual({ success: true, result: { value: 1 } });
    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({
        path: '/api/gateway/rpc',
        method: 'POST',
        timeoutMs: 45000,
      }),
    );
    const [, payload] = invokeIpcMock.mock.calls[0] as [string, { body?: string }];
    expect(payload.body).toBeTypeOf('string');
    expect(JSON.parse(payload.body ?? '{}')).toMatchObject({
      method: 'models.list',
      timeoutMs: 45000,
    });
  });

  it('hostFileReadText uses main-owned preview route', async () => {
    invokeIpcMock.mockResolvedValueOnce({
      ok: true,
      data: {
        status: 200,
        ok: true,
        json: { ok: true, content: '# Hello' },
      },
    });

    const { hostFileReadText } = await import('@/lib/host-api');
    const result = await hostFileReadText({ path: '/tmp/demo.md' });

    expect(result).toEqual({ ok: true, content: '# Hello' });
    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({
        path: '/api/files/read-text',
        method: 'POST',
      }),
    );
  });

  it('hostFileReadBinary uses main-owned preview route', async () => {
    invokeIpcMock.mockResolvedValueOnce({
      ok: true,
      data: {
        status: 200,
        ok: true,
        json: { ok: true, data: 'UEsDBA==' },
      },
    });

    const { hostFileReadBinary } = await import('@/lib/host-api');
    const result = await hostFileReadBinary({ path: '/tmp/demo.pdf' });

    expect(result).toEqual({ ok: true, data: 'UEsDBA==' });
    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({
        path: '/api/files/read-binary',
        method: 'POST',
      }),
    );
  });

  it('hostFileListDir uses main-owned preview route', async () => {
    invokeIpcMock.mockResolvedValueOnce({
      ok: true,
      data: {
        status: 200,
        ok: true,
        json: { ok: true, entries: [{ name: 'src', path: '/tmp/workspace/src', isDir: true, size: 0, mtimeMs: 0, hasChildren: true }] },
      },
    });

    const { hostFileListDir } = await import('@/lib/host-api');
    const result = await hostFileListDir({ path: '/tmp/workspace' });

    expect(result).toEqual({
      ok: true,
      entries: [{ name: 'src', path: '/tmp/workspace/src', isDir: true, size: 0, mtimeMs: 0, hasChildren: true }],
    });
    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({
        path: '/api/files/list-dir',
        method: 'POST',
        timeoutMs: 60000,
      }),
    );
  });

  it('hostGatewayRequest 透传调用方指定的 timeoutMs', async () => {
    invokeIpcMock.mockResolvedValueOnce({
      ok: true,
      data: {
        status: 200,
        ok: true,
        json: { success: true, result: { ok: true } },
      },
    });

    const { hostGatewayRequest } = await import('@/lib/host-api');
    await hostGatewayRequest<{ ok: boolean }>('chat.send', { message: 'hello' }, 120000);

    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({
        path: '/api/gateway/rpc',
        method: 'POST',
        timeoutMs: 120000,
      }),
    );
    const [, payload] = invokeIpcMock.mock.calls[0] as [string, { body?: string }];
    expect(JSON.parse(payload.body ?? '{}')).toMatchObject({
      method: 'chat.send',
      timeoutMs: 120000,
    });
  });

  it('hostSessionLoad 透传调用方指定的 timeoutMs', async () => {
    invokeIpcMock.mockResolvedValueOnce({
      ok: true,
      data: {
        status: 200,
        ok: true,
        json: { snapshot: { sessionKey: 'agent:main:main' } },
      },
    });

    const { hostSessionLoad } = await import('@/lib/host-api');
    await hostSessionLoad({ sessionKey: 'agent:main:main' }, { timeoutMs: 35000 });

    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({
        path: '/api/session/load',
        method: 'POST',
        timeoutMs: 35000,
      }),
    );
  });

  it('createHostEventSource 会附带 token 且复用缓存 token', async () => {
    const eventSourceCtor = vi.fn(function EventSourceCtor(this: unknown) {});
    vi.stubGlobal('EventSource', eventSourceCtor as unknown as typeof EventSource);
    invokeIpcMock.mockResolvedValueOnce('token-123');

    const { createHostEventSource } = await import('@/lib/host-api');
    await createHostEventSource('/api/events');
    await createHostEventSource('/api/events?foo=1');

    expect(invokeIpcMock).toHaveBeenCalledTimes(1);
    expect(invokeIpcMock).toHaveBeenCalledWith('hostapi:token');
    expect(eventSourceCtor).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:13210/api/events?token=token-123',
    );
    expect(eventSourceCtor).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:13210/api/events?foo=1&token=token-123',
    );
  });
});
