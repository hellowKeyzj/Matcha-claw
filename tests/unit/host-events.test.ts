import { beforeEach, describe, expect, it, vi } from 'vitest';

const addEventListenerMock = vi.fn();
const removeEventListenerMock = vi.fn();
const eventSourceMock = {
  addEventListener: addEventListenerMock,
  removeEventListener: removeEventListenerMock,
} as unknown as EventSource;

const createHostEventSourceMock = vi.fn(() => eventSourceMock);

vi.mock('@/lib/host-api', () => ({
  createHostEventSource: () => createHostEventSourceMock(),
}));

describe('host-events', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    window.localStorage.clear();
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
    expect(createHostEventSourceMock).not.toHaveBeenCalled();

    captured[0]({ eventName: 'gateway:status', payload: { state: 'running' } });
    expect(handler).toHaveBeenCalledWith({ state: 'running' });

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
    expect(createHostEventSourceMock).not.toHaveBeenCalled();
    captured[0]({ eventName: 'another:event', payload: { ignored: true } });
    captured[0]({ eventName: 'unknown:event', payload: { ok: true } });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ ok: true });
    unsubscribe();
  });

  it('uses SSE fallback only when IPC is unavailable and explicitly enabled', async () => {
    (window as unknown as { electron?: unknown }).electron = undefined;
    window.localStorage.setItem('clawx:allow-sse-fallback', '1');
    const { subscribeHostEvent } = await import('@/lib/host-events');
    const handler = vi.fn();
    const unsubscribe = subscribeHostEvent('unknown:event', handler);

    expect(createHostEventSourceMock).toHaveBeenCalledTimes(1);
    expect(addEventListenerMock).toHaveBeenCalledWith('unknown:event', expect.any(Function));

    const listener = addEventListenerMock.mock.calls[0][1] as (event: Event) => void;
    listener({ data: JSON.stringify({ x: 1 }) } as unknown as Event);
    expect(handler).toHaveBeenCalledWith({ x: 1 });

    unsubscribe();
    expect(removeEventListenerMock).toHaveBeenCalledWith('unknown:event', expect.any(Function));
  });
});
