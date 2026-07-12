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

describe('gateway manager process facade', () => {
  it('delegates start and stop to the injected process controller', async () => {
    const manager = new GatewayManager();
    const controller = createProcessController();
    manager.setProcessController(controller);

    await manager.start();
    await manager.stop();

    expect(controller.start).toHaveBeenCalledTimes(1);
    expect(controller.stop).toHaveBeenCalledTimes(1);
    expect(controller.restart).not.toHaveBeenCalled();
  });

  it('delegates restart without owning stop/start sequencing', async () => {
    const manager = new GatewayManager();
    const controller = createProcessController();
    manager.setProcessController(controller);

    await manager.restart();

    expect(controller.restart).toHaveBeenCalledTimes(1);
    expect(controller.start).not.toHaveBeenCalled();
    expect(controller.stop).not.toHaveBeenCalled();
  });

  it('requires a process controller before lifecycle commands can run', async () => {
    const manager = new GatewayManager();

    await expect(manager.start()).rejects.toThrow('Gateway process controller is not configured');
    await expect(manager.stop()).rejects.toThrow('Gateway process controller is not configured');
    await expect(manager.restart()).rejects.toThrow('Gateway process controller is not configured');
  });
});
