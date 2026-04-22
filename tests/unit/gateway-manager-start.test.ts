import { beforeEach, describe, expect, it, vi } from 'vitest';

const waitForGatewayPortReadyMock = vi.fn(async () => undefined);
const prepareGatewayLaunchContextMock = vi.fn(async () => ({}));
const unloadLaunchctlGatewayServiceMock = vi.fn(async () => undefined);
const launchGatewayProcessMock = vi.fn(async ({ onSpawn }: { onSpawn?: (pid: number) => void }) => {
  onSpawn?.(4242);
  return {
    child: { pid: 4242 },
    lastSpawnSummary: 'mock-spawn',
  };
});

vi.mock('../../electron/gateway/port-readiness', () => ({
  waitForGatewayPortReady: (...args: unknown[]) => waitForGatewayPortReadyMock(...args),
}));

vi.mock('../../electron/gateway/config-sync', () => ({
  prepareGatewayLaunchContext: (...args: unknown[]) => prepareGatewayLaunchContextMock(...args),
}));

vi.mock('../../electron/gateway/supervisor', () => ({
  findExistingGatewayProcess: vi.fn(async () => null),
  runOpenClawDoctorRepair: vi.fn(async () => false),
  terminateOwnedGatewayProcess: vi.fn(async () => undefined),
  unloadLaunchctlGatewayService: (...args: unknown[]) => unloadLaunchctlGatewayServiceMock(...args),
  waitForPortFree: vi.fn(async () => undefined),
  warmupManagedPythonReadiness: vi.fn(),
}));

vi.mock('../../electron/gateway/process-launcher', () => ({
  launchGatewayProcess: (...args: unknown[]) => launchGatewayProcessMock(...args),
}));

describe('gateway manager start', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('启动成功需要等待控制面 ready，端口 ready 后才切 control_connecting', async () => {
    const { GatewayManager } = await import('../../electron/gateway/manager');

    const manager = new GatewayManager();
    const controlReadyProbeMock = vi.fn(async () => {
      expect(manager.getStatus()).toEqual(expect.objectContaining({
        state: 'control_connecting',
        pid: 4242,
      }));
    });
    manager.setControlReadyProbe(controlReadyProbeMock);

    await expect(manager.start()).resolves.toBeUndefined();

    expect(waitForGatewayPortReadyMock).toHaveBeenCalledTimes(1);
    expect(controlReadyProbeMock).toHaveBeenCalledTimes(1);
    expect(manager.getStatus()).toEqual(expect.objectContaining({
      state: 'running',
      pid: 4242,
    }));
  });
});
