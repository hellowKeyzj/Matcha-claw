import { describe, expect, it, vi } from 'vitest';
import { GatewayManager, type GatewayProcessController } from '../../electron/main/process-runtime/openclaw-gateway/manager';

function createProcessController(overrides: Partial<GatewayProcessController> = {}): GatewayProcessController {
  return {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    restart: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('GatewayManager restart facade', () => {
  it('surfaces process-controller restart failures to the caller', async () => {
    const restartError = new Error('Gateway control ready check failed: Gateway socket closed before connect');
    const manager = new GatewayManager();
    const controller = createProcessController({
      restart: vi.fn(async () => {
        throw restartError;
      }),
    });
    manager.setProcessController(controller);

    await expect(manager.restart()).rejects.toThrow(restartError.message);

    expect(controller.restart).toHaveBeenCalledTimes(1);
    expect(controller.start).not.toHaveBeenCalled();
    expect(controller.stop).not.toHaveBeenCalled();
  });

  it('defers restart while startup is in flight and executes it after running', async () => {
    const manager = new GatewayManager();
    const controller = createProcessController();
    manager.setProcessController(controller);

    manager.markStarting();
    await expect(manager.restart()).resolves.toEqual({ status: 'deferred' });
    expect(controller.restart).not.toHaveBeenCalled();

    manager.markRunning();
    await Promise.resolve();

    expect(controller.restart).toHaveBeenCalledTimes(1);
  });

  it('drops deferred restart when the gateway stops before startup settles', async () => {
    const manager = new GatewayManager();
    const controller = createProcessController();
    manager.setProcessController(controller);

    manager.markStarting();
    await expect(manager.restart()).resolves.toEqual({ status: 'deferred' });
    manager.markStopped();
    await Promise.resolve();

    expect(controller.restart).not.toHaveBeenCalled();
  });

  it('clears pending debounced restart when stopping', async () => {
    vi.useFakeTimers();
    try {
      const manager = new GatewayManager();
      const controller = createProcessController();
      manager.setProcessController(controller);

      manager.debouncedRestart(1000);
      await manager.stop();
      await vi.advanceTimersByTimeAsync(1000);

      expect(controller.stop).toHaveBeenCalledTimes(1);
      expect(controller.restart).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears pending debounced reload when stopping', async () => {
    vi.useFakeTimers();
    try {
      const manager = new GatewayManager();
      const controller = createProcessController();
      manager.setProcessController(controller);

      manager.markLaunched(1234);
      manager.markRunning();
      manager.debouncedReload(1000);
      await manager.stop();
      await vi.advanceTimersByTimeAsync(1000);

      expect(controller.stop).toHaveBeenCalledTimes(1);
      expect(controller.restart).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears pending debounced restart when marked stopped', async () => {
    vi.useFakeTimers();
    try {
      const manager = new GatewayManager();
      const controller = createProcessController();
      manager.setProcessController(controller);

      manager.debouncedRestart(1000);
      manager.markStopped();
      await vi.advanceTimersByTimeAsync(1000);

      expect(controller.restart).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears pending debounced reload when marked stopped', async () => {
    vi.useFakeTimers();
    try {
      const manager = new GatewayManager();
      const controller = createProcessController();
      manager.setProcessController(controller);

      manager.markLaunched(1234);
      manager.markRunning();
      manager.debouncedReload(1000);
      manager.markStopped();
      await vi.advanceTimersByTimeAsync(1000);

      expect(controller.restart).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
