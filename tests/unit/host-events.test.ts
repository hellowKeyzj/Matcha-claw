import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/host-api', () => ({}));

describe('host-events', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    window.localStorage.clear();
    delete (window as unknown as Record<string, unknown>).__MATCHACLAW_HOST_EVENT_HUB__;
  });

  it('subscribes through IPC for mapped host events', async () => {
    const onMock = vi.mocked(window.electron.ipcRenderer.on);
    const offMock = vi.mocked(window.electron.ipcRenderer.off);
    const captured: Array<(...args: unknown[]) => void> = [];
    const returnedUnsubscribe = vi.fn();
    onMock.mockImplementation((_, cb: (...args: unknown[]) => void) => {
      captured.push(cb);
      return returnedUnsubscribe;
    });

    const { subscribeHostEvent } = await import('@/lib/host-events');
    const handler = vi.fn();
    const unsubscribe = subscribeHostEvent('gateway:status', handler);

    expect(onMock).toHaveBeenCalledWith('host:event', expect.any(Function));

    captured[0]({
      eventName: 'gateway:status',
      payload: {
        processState: 'running',
        port: 18789,
        gatewayReady: true,
        healthSummary: 'healthy',
        transportState: 'connected',
        portReachable: true,
        diagnostics: {
          consecutiveHeartbeatMisses: 0,
          consecutiveRpcFailures: 0,
        },
        updatedAt: 1,
      },
    });
    expect(handler).toHaveBeenCalledWith({
      processState: 'running',
      port: 18789,
      gatewayReady: true,
      healthSummary: 'healthy',
      transportState: 'connected',
      portReachable: true,
      diagnostics: {
        consecutiveHeartbeatMisses: 0,
        consecutiveRpcFailures: 0,
      },
      updatedAt: 1,
    });

    unsubscribe();
    expect(returnedUnsubscribe).toHaveBeenCalledTimes(1);
    expect(offMock).not.toHaveBeenCalled();
  });

  it('does not use SSE fallback by default for unknown events', async () => {
    const onMock = vi.mocked(window.electron.ipcRenderer.on);
    const captured: Array<(...args: unknown[]) => void> = [];
    onMock.mockImplementation((_, cb: (...args: unknown[]) => void) => {
      captured.push(cb);
      return vi.fn();
    });
    const { subscribeHostEvent } = await import('@/lib/host-events');
    const handler = vi.fn();
    const unsubscribe = subscribeHostEvent('unknown:event', handler);
    expect(onMock).toHaveBeenCalledWith('host:event', expect.any(Function));
    captured[0]({ eventName: 'another:event', payload: { ignored: true } });
    captured[0]({ eventName: 'unknown:event', payload: { ok: true } });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ ok: true });
    unsubscribe();
  });

  it('does not fall back to SSE when IPC bridge is unavailable', async () => {
    const warnMock = vi.spyOn(console, 'warn').mockImplementation(() => {});
    (window as unknown as { electron?: unknown }).electron = undefined;
    window.localStorage.setItem('matchaclaw:allow-sse-fallback', '1');

    const { subscribeHostEvent } = await import('@/lib/host-events');
    const unsubscribe = subscribeHostEvent('unknown:event', vi.fn());

    await Promise.resolve();
    expect(warnMock).toHaveBeenCalledWith(
      '[host-events] host:event unavailable, event subscription disabled for "unknown:event"',
    );

    unsubscribe();
    warnMock.mockRestore();
  });
});
