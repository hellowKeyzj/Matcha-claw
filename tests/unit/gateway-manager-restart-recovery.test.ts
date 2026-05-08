import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp',
    isPackaged: false,
  },
  utilityProcess: {
    fork: vi.fn(),
  },
}));

vi.mock('../../electron/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('GatewayManager restart recovery', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('restart 期间 start 失败后会安排自动重连自愈', async () => {
    const { GatewayManager } = await import('../../electron/gateway/manager');
    const manager = new GatewayManager();

    const internals = manager as unknown as {
      shouldReconnect: boolean;
      status: { processState: string; port: number };
      startLock: boolean;
      reconnectTimer: NodeJS.Timeout | null;
      restartInFlight: Promise<void> | null;
      scheduleReconnect: () => void;
    };

    internals.status = { processState: 'running', port: 18789 };
    internals.startLock = false;
    internals.shouldReconnect = true;

    vi.spyOn(manager, 'stop').mockImplementation(async () => {
      internals.shouldReconnect = false;
      internals.status = { processState: 'stopped', port: 18789 };
    });

    vi.spyOn(manager, 'start').mockImplementation(async () => {
      internals.shouldReconnect = true;
      internals.status = { processState: 'error', port: 18789 };
      throw new Error('Gateway control ready check failed: Gateway socket closed before connect');
    });

    const scheduleReconnectSpy = vi.spyOn(
      internals as unknown as { scheduleReconnect: () => void },
      'scheduleReconnect',
    );

    await expect(manager.restart()).rejects.toThrow(
      'Gateway control ready check failed: Gateway socket closed before connect',
    );

    expect(internals.shouldReconnect).toBe(true);
    expect(scheduleReconnectSpy).toHaveBeenCalledTimes(1);
  });

  it('restart 成功时不会额外安排自动重连', async () => {
    const { GatewayManager } = await import('../../electron/gateway/manager');
    const manager = new GatewayManager();

    const internals = manager as unknown as {
      shouldReconnect: boolean;
      status: { processState: string; port: number };
      startLock: boolean;
      reconnectTimer: NodeJS.Timeout | null;
      restartInFlight: Promise<void> | null;
      scheduleReconnect: () => void;
    };

    internals.status = { processState: 'running', port: 18789 };
    internals.startLock = false;
    internals.shouldReconnect = true;

    vi.spyOn(manager, 'stop').mockImplementation(async () => {
      internals.shouldReconnect = false;
      internals.status = { processState: 'stopped', port: 18789 };
    });

    vi.spyOn(manager, 'start').mockImplementation(async () => {
      internals.shouldReconnect = true;
      internals.status = { processState: 'running', port: 18789 };
    });

    const scheduleReconnectSpy = vi.spyOn(
      internals as unknown as { scheduleReconnect: () => void },
      'scheduleReconnect',
    );

    await expect(manager.restart()).resolves.toBeUndefined();

    expect(scheduleReconnectSpy).not.toHaveBeenCalled();
  });
});
