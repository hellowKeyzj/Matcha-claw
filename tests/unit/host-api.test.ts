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

  it('waitForRuntimeJobResult 在 done 事件缺失时轮询到终态', async () => {
    vi.useFakeTimers();
    try {
      invokeIpcMock
        .mockResolvedValueOnce({
          ok: true,
          data: {
            status: 200,
            ok: true,
            json: {
              success: true,
              job: {
                id: 'job-1',
                type: 'sessions.hydrateTimeline',
                status: 'queued',
                queuedAt: 1,
                attempts: 0,
                maxAttempts: 1,
              },
            },
          },
        })
        .mockResolvedValueOnce({
          ok: true,
          data: {
            status: 200,
            ok: true,
            json: {
              success: true,
              job: {
                id: 'job-1',
                type: 'sessions.hydrateTimeline',
                status: 'running',
                queuedAt: 1,
                startedAt: 2,
                attempts: 1,
                maxAttempts: 1,
              },
            },
          },
        })
        .mockResolvedValueOnce({
          ok: true,
          data: {
            status: 200,
            ok: true,
            json: {
              success: true,
              job: {
                id: 'job-1',
                type: 'sessions.hydrateTimeline',
                status: 'succeeded',
                queuedAt: 1,
                startedAt: 2,
                finishedAt: 3,
                attempts: 1,
                maxAttempts: 1,
              },
            },
          },
        });

      const { waitForRuntimeJobResult } = await import('@/lib/host-api');
      const result = waitForRuntimeJobResult('job-1', { intervalMs: 50, timeoutMs: 1000 });

      await vi.advanceTimersByTimeAsync(50);
      await vi.advanceTimersByTimeAsync(100);

      await expect(result).resolves.toBeUndefined();
      expect(invokeIpcMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waitForRuntimeJobResult 对缺失 job 使用宽限期后失败，避免无限轮询', async () => {
    vi.useFakeTimers();
    try {
      invokeIpcMock.mockResolvedValue({
        ok: true,
        data: {
          status: 200,
          ok: true,
          json: {
            success: true,
            job: null,
          },
        },
      });

      const { waitForRuntimeJobResult } = await import('@/lib/host-api');
      const assertion = expect(
        waitForRuntimeJobResult('missing-job', { intervalMs: 500, timeoutMs: 5000 }),
      ).rejects.toThrow('runtime job not found: missing-job');

      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(2000);

      await assertion;
      expect(invokeIpcMock).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
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
