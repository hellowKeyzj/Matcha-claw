import { beforeEach, describe, expect, it, vi } from 'vitest';

const waitForGatewayPortReadyMock = vi.fn(async () => undefined);
const prepareGatewayLaunchContextMock = vi.fn(async () => ({}));
const unloadLaunchctlGatewayServiceMock = vi.fn(async () => undefined);
const runGatewayStartupSequenceMock = vi.fn();
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

vi.mock('../../electron/gateway/startup-orchestrator', () => ({
  runGatewayStartupSequence: (...args: unknown[]) => runGatewayStartupSequenceMock(...args),
}));

describe('gateway manager start', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runGatewayStartupSequenceMock.mockImplementation(async (hooks: {
      startProcess: () => Promise<void>;
      waitForPortReady: (port: number) => Promise<void>;
      onManagedGatewayPortReady: () => void;
      waitForControlReady: (port: number) => Promise<void>;
      onConnectedToManagedGateway: () => void;
      port: number;
    }) => {
      await hooks.startProcess();
      await hooks.waitForPortReady(hooks.port);
      hooks.onManagedGatewayPortReady();
      await hooks.waitForControlReady(hooks.port);
      hooks.onConnectedToManagedGateway();
    });
  });

  it('启动成功需要等待控制面 ready，端口 ready 后才切 control_connecting', async () => {
    const { GatewayManager } = await import('../../electron/gateway/manager');

    const manager = new GatewayManager();
    manager.setRuntimeHostManager({
      onRuntimeJobEvent: () => () => {},
    } as never);
    const controlReadyProbeMock = vi.fn(async () => {
      expect(manager.getStatus()).toEqual(expect.objectContaining({
        processState: 'control_connecting',
        pid: 4242,
      }));
    });
    manager.setControlReadyProbe(controlReadyProbeMock);

    await expect(manager.start()).resolves.toBeUndefined();

    expect(waitForGatewayPortReadyMock).toHaveBeenCalledTimes(1);
    expect(controlReadyProbeMock).toHaveBeenCalledTimes(1);
    expect(manager.getStatus()).toEqual(expect.objectContaining({
      processState: 'running',
      pid: 4242,
    }));
  });

  it('重连到自管 gateway 时会记录 restart 完成，避免重复 deferred restart', async () => {
    const { GatewayManager } = await import('../../electron/gateway/manager');
    const manager = new GatewayManager();
    const internals = manager as unknown as {
      process: { pid: number } | null;
      ownsProcess: boolean;
      restartController: { recordRestartCompleted: () => void };
    };

    internals.process = { pid: 4242 };
    internals.ownsProcess = true;

    const recordRestartCompletedSpy = vi.spyOn(internals.restartController, 'recordRestartCompleted');
    manager.setRuntimeHostManager({
      onRuntimeJobEvent: () => () => {},
    } as never);
    manager.setControlReadyProbe(vi.fn(async () => {}));
    runGatewayStartupSequenceMock.mockImplementationOnce(async (hooks: {
      onConnectedToExistingGateway: () => void;
    }) => {
      hooks.onConnectedToExistingGateway();
    });

    await expect(manager.start()).resolves.toBeUndefined();

    expect(recordRestartCompletedSpy).toHaveBeenCalledTimes(1);
  });
});
