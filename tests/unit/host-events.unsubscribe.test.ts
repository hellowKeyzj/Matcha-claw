import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('host events unsubscribe', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete (window as unknown as Record<string, unknown>).__MATCHACLAW_HOST_EVENT_HUB__;
  });

  it('优先使用 preload on() 返回的退订函数，避免监听器泄漏', async () => {
    const unsubscribe = vi.fn();
    const on = vi.fn().mockReturnValue(unsubscribe);
    const off = vi.fn();

    (window as unknown as { electron: unknown }).electron = {
      ipcRenderer: { on, off },
    };

    const { subscribeHostEvent } = await import('@/lib/host-events');
    const dispose = subscribeHostEvent('gateway:channel-status', vi.fn());
    dispose();

    expect(on).toHaveBeenCalledTimes(1);
    expect(on).toHaveBeenCalledWith('host:event', expect.any(Function));
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(off).not.toHaveBeenCalled();
  });

  it('兼容无返回值的 on()：回退到 off(channel, listener)', async () => {
    const on = vi.fn();
    const off = vi.fn();

    (window as unknown as { electron: unknown }).electron = {
      ipcRenderer: { on, off },
    };

    const { subscribeHostEvent } = await import('@/lib/host-events');
    const dispose = subscribeHostEvent('gateway:channel-status', vi.fn());
    dispose();

    expect(on).toHaveBeenCalledTimes(1);
    expect(on).toHaveBeenCalledWith('host:event', expect.any(Function));
    expect(off).toHaveBeenCalledTimes(1);
    expect(off).toHaveBeenCalledWith('host:event', expect.any(Function));
  });

  it('多个事件订阅应复用单个 host:event listener，并在最后一个订阅释放后再退订', async () => {
    const unsubscribe = vi.fn();
    const on = vi.fn().mockReturnValue(unsubscribe);
    const off = vi.fn();

    (window as unknown as { electron: unknown }).electron = {
      ipcRenderer: { on, off },
    };

    const { subscribeHostEvent } = await import('@/lib/host-events');
    const disposeStatus = subscribeHostEvent('gateway:status', vi.fn());
    const disposeError = subscribeHostEvent('gateway:error', vi.fn());

    expect(on).toHaveBeenCalledTimes(1);
    expect(on).toHaveBeenCalledWith('host:event', expect.any(Function));

    disposeStatus();
    expect(unsubscribe).not.toHaveBeenCalled();

    disposeError();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(off).not.toHaveBeenCalled();
  });
});
