import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatewayManager, type GatewayProcessController } from '../../electron/main/process-runtime/openclaw-gateway/manager';

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    ...originalPlatformDescriptor,
    value: platform,
  });
}

function restorePlatform(): void {
  if (originalPlatformDescriptor) {
    Object.defineProperty(process, 'platform', originalPlatformDescriptor);
  }
}

function createProcessController(overrides: Partial<GatewayProcessController> = {}): GatewayProcessController {
  return {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    restart: vi.fn(async () => undefined),
    ...overrides,
  };
}

function createGatewayManager(controller = createProcessController()): {
  manager: GatewayManager;
  controller: GatewayProcessController;
} {
  const manager = new GatewayManager();
  manager.setProcessController(controller);
  return { manager, controller };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  restorePlatform();
});

describe('GatewayManager reload facade', () => {
  it('falls back to restart when running status has no pid', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const { manager, controller } = createGatewayManager();

    manager.markRunning();
    await manager.reload();

    expect(killSpy).not.toHaveBeenCalled();
    expect(controller.restart).toHaveBeenCalledTimes(1);
    expect(controller.start).not.toHaveBeenCalled();
    expect(controller.stop).not.toHaveBeenCalled();
  });

  it('defers fallback restart while startup is in flight', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const { manager, controller } = createGatewayManager();

    manager.markStarting();
    manager.markLaunched(4321);
    await manager.reload();

    expect(killSpy).not.toHaveBeenCalled();
    expect(controller.restart).not.toHaveBeenCalled();

    manager.markRunning();
    await Promise.resolve();

    expect(controller.restart).toHaveBeenCalledTimes(1);
  });

  it('falls back to restart on Windows without sending SIGUSR1', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const { manager, controller } = createGatewayManager();

    setPlatform('win32');
    manager.markLaunched(4321);
    manager.markRunning();
    await manager.reload();

    expect(killSpy).not.toHaveBeenCalled();
    expect(controller.restart).toHaveBeenCalledTimes(1);
  });

  it('skips signal and restart when the gateway connected less than 8 seconds ago', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-04-09T12:00:00.000Z'));
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
      const { manager, controller } = createGatewayManager();

      setPlatform('linux');
      manager.markLaunched(4321);
      manager.markRunning();
      vi.setSystemTime(new Date('2026-04-09T12:00:07.999Z'));
      await manager.reload();

      expect(killSpy).not.toHaveBeenCalled();
      expect(controller.restart).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends SIGUSR1 and does not restart when the gateway stays running', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-04-09T12:00:00.000Z'));
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
      const { manager, controller } = createGatewayManager();

      setPlatform('linux');
      manager.markLaunched(4321);
      manager.markRunning();
      vi.setSystemTime(new Date('2026-04-09T12:00:09.000Z'));

      const reloadPromise = manager.reload();
      expect(killSpy).toHaveBeenCalledWith(4321, 'SIGUSR1');

      await vi.advanceTimersByTimeAsync(1500);
      await reloadPromise;

      expect(killSpy).toHaveBeenCalledTimes(1);
      expect(controller.restart).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to restart when SIGUSR1 throws', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-04-09T12:00:00.000Z'));
      const signalError = new Error('process is gone');
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
        throw signalError;
      });
      const { manager, controller } = createGatewayManager();

      setPlatform('linux');
      manager.markLaunched(4321);
      manager.markRunning();
      vi.setSystemTime(new Date('2026-04-09T12:00:09.000Z'));
      await manager.reload();

      expect(killSpy).toHaveBeenCalledWith(4321, 'SIGUSR1');
      expect(controller.restart).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to restart when the gateway stops after the reload signal', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-04-09T12:00:00.000Z'));
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
      const { manager, controller } = createGatewayManager();

      setPlatform('linux');
      manager.markLaunched(4321);
      manager.markRunning();
      vi.setSystemTime(new Date('2026-04-09T12:00:09.000Z'));

      const reloadPromise = manager.reload();
      expect(killSpy).toHaveBeenCalledWith(4321, 'SIGUSR1');

      manager.markStopped();
      await vi.advanceTimersByTimeAsync(1500);
      await reloadPromise;

      expect(controller.restart).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
