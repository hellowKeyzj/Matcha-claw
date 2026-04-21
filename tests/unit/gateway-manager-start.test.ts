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

  it('启动成功只依赖端口 ready，不再额外阻塞 runtime health 握手', async () => {
    const { GatewayManager } = await import('../../electron/gateway/manager');

    const manager = new GatewayManager();
    const runtimeHealthRequestMock = vi.fn(async () => {
      throw new Error('runtime health should not be awaited during start');
    });
    (manager as unknown as { runtimeHostClient: { request: typeof runtimeHealthRequestMock } }).runtimeHostClient = {
      request: runtimeHealthRequestMock,
    };

    await expect(manager.start()).resolves.toBeUndefined();

    expect(waitForGatewayPortReadyMock).toHaveBeenCalledTimes(1);
    expect(runtimeHealthRequestMock).not.toHaveBeenCalled();
    expect(manager.getStatus()).toEqual(expect.objectContaining({
      state: 'running',
      pid: 4242,
    }));
  });
});
