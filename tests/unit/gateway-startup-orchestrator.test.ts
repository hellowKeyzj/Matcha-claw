import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runGatewayStartupSequence } from '../../electron/gateway/startup-orchestrator';
import { LifecycleSupersededError } from '../../electron/gateway/lifecycle-controller';

function createMockHooks(overrides: Partial<Parameters<typeof runGatewayStartupSequence>[0]> = {}) {
  return {
    port: 18789,
    shouldWaitForPortFree: true,
    resetStartupStderrLines: vi.fn(),
    getStartupStderrLines: vi.fn().mockReturnValue([]),
    assertLifecycle: vi.fn(),
    findExistingGateway: vi.fn().mockResolvedValue(null),
    waitForControlReady: vi.fn().mockResolvedValue(undefined),
    onConnectedToExistingGateway: vi.fn(),
    waitForPortFree: vi.fn().mockResolvedValue(undefined),
    startProcess: vi.fn().mockResolvedValue(undefined),
    waitForPortReady: vi.fn().mockResolvedValue(undefined),
    onManagedGatewayPortReady: vi.fn(),
    onConnectedToManagedGateway: vi.fn(),
    runDoctorRepair: vi.fn().mockResolvedValue(false),
    onDoctorRepairSuccess: vi.fn(),
    delay: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('runGatewayStartupSequence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('发现现有 gateway 时只等待 control ready，不重复拉起新进程', async () => {
    const hooks = createMockHooks({
      findExistingGateway: vi.fn().mockResolvedValue({ port: 18789 }),
    });

    await runGatewayStartupSequence(hooks);

    expect(hooks.findExistingGateway).toHaveBeenCalledWith(18789);
    expect(hooks.waitForControlReady).toHaveBeenCalledWith(18789, undefined);
    expect(hooks.onConnectedToExistingGateway).toHaveBeenCalledTimes(1);
    expect(hooks.startProcess).not.toHaveBeenCalled();
    expect(hooks.waitForPortFree).not.toHaveBeenCalled();
    expect(hooks.onConnectedToManagedGateway).not.toHaveBeenCalled();
  });

  it('现有 gateway control ready 瞬态失败时会重试同一路径而不是直接起新进程', async () => {
    let readyAttempts = 0;
    const hooks = createMockHooks({
      findExistingGateway: vi.fn().mockResolvedValue({ port: 18789 }),
      waitForControlReady: vi.fn().mockImplementation(async () => {
        readyAttempts += 1;
        if (readyAttempts === 1) {
          throw new Error('Gateway control ready check failed: Gateway socket closed before connect');
        }
      }),
    });

    await runGatewayStartupSequence(hooks);

    expect(hooks.findExistingGateway).toHaveBeenCalledTimes(2);
    expect(hooks.waitForControlReady).toHaveBeenCalledTimes(2);
    expect(hooks.delay).toHaveBeenCalledWith(1000);
    expect(hooks.startProcess).not.toHaveBeenCalled();
    expect(hooks.onConnectedToExistingGateway).toHaveBeenCalledTimes(1);
  });

  it('LifecycleSupersededError 不会被吞掉重试', async () => {
    const hooks = createMockHooks({
      startProcess: vi.fn().mockRejectedValue(
        new LifecycleSupersededError('Lifecycle superseded during start'),
      ),
    });

    await expect(runGatewayStartupSequence(hooks)).rejects.toThrow(LifecycleSupersededError);
    expect(hooks.startProcess).toHaveBeenCalledTimes(1);
    expect(hooks.delay).not.toHaveBeenCalled();
  });
});
