import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayRestartController } from '../../electron/gateway/restart-controller';

describe('gateway restart controller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-09T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('在生命周期稳定后执行延迟重启', () => {
    const controller = new GatewayRestartController();
    const executeRestart = vi.fn();

    controller.markDeferredRestart('reload', { state: 'starting', startLock: true });
    controller.flushDeferredRestart(
      'status:starting->running',
      { state: 'running', startLock: false, shouldReconnect: true },
      executeRestart,
    );

    expect(executeRestart).toHaveBeenCalledTimes(1);
  });

  it('若请求后已有重启完成则丢弃重复延迟重启', () => {
    const controller = new GatewayRestartController();
    const executeRestart = vi.fn();

    controller.markDeferredRestart('restart', { state: 'starting', startLock: true });
    vi.setSystemTime(new Date('2026-04-09T12:00:05.000Z'));
    controller.recordRestartCompleted();

    controller.flushDeferredRestart(
      'start:finally',
      { state: 'running', startLock: false, shouldReconnect: true },
      executeRestart,
    );

    expect(executeRestart).not.toHaveBeenCalled();
  });
});
