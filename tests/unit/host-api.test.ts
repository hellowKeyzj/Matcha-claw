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
