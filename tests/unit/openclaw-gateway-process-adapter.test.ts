import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waitForGatewayControlReady } from '../../electron/main/gateway-control-ready-probe';
import { LocalProcessRuntime } from '../../electron/main/process-runtime/local-process-runtime';
import type { GatewayLaunchContext } from '../../electron/main/process-runtime/openclaw-gateway/config-sync';
import type { LocalProcessLaunchPlan } from '../../electron/main/process-runtime/contracts';

const hoisted = vi.hoisted(() => ({
  findExistingGatewayProcess: vi.fn(),
  runOpenClawDoctorRepair: vi.fn(),
  terminateGatewayProcessIds: vi.fn(),
  unloadLaunchctlGatewayService: vi.fn(),
  waitForPortFree: vi.fn(),
  warmupManagedPythonReadiness: vi.fn(),
  prepareGatewayRuntimeBeforeLaunch: vi.fn(),
  loadHostBootstrapSettings: vi.fn(),
  createGatewayLaunchContext: vi.fn(),
  waitForGatewayPortReady: vi.fn(),
  buildGatewayLaunchPlan: vi.fn(),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../electron/utils/logger', () => ({
  logger: hoisted.logger,
}));

vi.mock('../../electron/main/process-runtime/openclaw-gateway/supervisor', () => ({
  findExistingGatewayProcess: hoisted.findExistingGatewayProcess,
  runOpenClawDoctorRepair: hoisted.runOpenClawDoctorRepair,
  terminateGatewayProcessIds: hoisted.terminateGatewayProcessIds,
  unloadLaunchctlGatewayService: hoisted.unloadLaunchctlGatewayService,
  waitForPortFree: hoisted.waitForPortFree,
  warmupManagedPythonReadiness: hoisted.warmupManagedPythonReadiness,
}));

vi.mock('../../electron/main/process-runtime/openclaw-gateway/config-sync', () => ({
  prepareGatewayRuntimeBeforeLaunch: hoisted.prepareGatewayRuntimeBeforeLaunch,
  loadHostBootstrapSettings: hoisted.loadHostBootstrapSettings,
  createGatewayLaunchContext: hoisted.createGatewayLaunchContext,
}));

vi.mock('../../electron/main/process-runtime/openclaw-gateway/port-readiness', () => ({
  waitForGatewayPortReady: hoisted.waitForGatewayPortReady,
}));

vi.mock('../../electron/main/process-runtime/openclaw-gateway/process-launcher', () => ({
  buildGatewayLaunchPlan: hoisted.buildGatewayLaunchPlan,
}));

const launchContext: GatewayLaunchContext = {
  openclawDir: '/tmp/openclaw',
  entryScript: '/tmp/openclaw/openclaw.mjs',
  gatewayArgs: ['gateway', '--port', '18789'],
  forkEnv: {},
  mode: 'dev',
  binPathExists: true,
  loadedProviderKeyCount: 0,
  proxySummary: 'disabled',
  channelStartupSummary: 'enabled(unknown)',
};

const managedPlan: LocalProcessLaunchPlan = {
  kind: 'utility',
  command: '/tmp/openclaw/openclaw.mjs',
  args: ['gateway', '--port', '18789'],
  cwd: '/tmp/openclaw',
  stdio: 'pipe',
  serviceName: 'OpenClaw Gateway',
  terminateProcessTree: true,
  port: 18789,
};

const managedPlanWithDirectKill: LocalProcessLaunchPlan = {
  ...managedPlan,
  terminateProcessTree: false,
};

const gatewayLaunchPlan = {
  gatewayToken: 'gateway-token',
  providerEnv: {},
  loadedProviderKeyCount: 0,
  skipChannels: false,
  channelStartupSummary: 'enabled(unknown)',
};

const repairedGatewayLaunchPlan = {
  ...gatewayLaunchPlan,
  gatewayToken: 'gateway-token-after-doctor-repair',
};

const recoveredGatewayLaunchPlan = {
  ...gatewayLaunchPlan,
  gatewayToken: 'gateway-token-after-prelaunch-retry',
};

async function createAdapterFixture() {
  const { GatewayManager } = await import('../../electron/main/process-runtime/openclaw-gateway/manager');
  const { OpenClawGatewayProcessAdapter } = await import(
    '../../electron/main/process-runtime/adapters/openclaw-gateway-process-adapter'
  );
  const manager = new GatewayManager();
  manager.setRuntimeHostManager({ onRuntimeJobEvent: () => () => {} } as never);
  const delay = vi.fn(async () => undefined);
  const adapter = new OpenClawGatewayProcessAdapter({
    gatewayManager: manager,
    maxStartAttempts: 3,
    delay,
  });
  return { adapter, delay, manager };
}

describe('OpenClawGatewayProcessAdapter', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    hoisted.findExistingGatewayProcess.mockResolvedValue(null);
    hoisted.runOpenClawDoctorRepair.mockResolvedValue(false);
    hoisted.terminateGatewayProcessIds.mockResolvedValue(undefined);
    hoisted.unloadLaunchctlGatewayService.mockResolvedValue(undefined);
    hoisted.waitForPortFree.mockResolvedValue(undefined);
    hoisted.prepareGatewayRuntimeBeforeLaunch.mockResolvedValue(gatewayLaunchPlan);
    hoisted.loadHostBootstrapSettings.mockResolvedValue({
      gatewayToken: '',
      proxyEnabled: false,
      proxyServer: '',
      proxyBypassRules: '',
    });
    hoisted.createGatewayLaunchContext.mockResolvedValue(launchContext);
    hoisted.waitForGatewayPortReady.mockResolvedValue(undefined);
    hoisted.buildGatewayLaunchPlan.mockReturnValue({
      plan: managedPlan,
      lastSpawnSummary: 'mode=dev, entry="/tmp/openclaw/openclaw.mjs"',
    });
  });

  it('attaches to an existing gateway without building a managed launch plan', async () => {
    const existingGateway = {
      port: 19000,
      externalToken: 'external-token',
    };
    hoisted.findExistingGatewayProcess.mockResolvedValueOnce(existingGateway);
    const { adapter, manager } = await createAdapterFixture();
    const controlReadyProbe = vi.fn(async () => undefined);
    manager.markLaunched(4321);
    const statusBeforeAttach = manager.getStatus();
    manager.setControlReadyProbe(controlReadyProbe);

    const plan = await adapter.prepareLaunch({ nowMs: () => 0, attempt: 1 });

    expect(hoisted.findExistingGatewayProcess).toHaveBeenCalledWith({
      port: statusBeforeAttach.port,
      ownedPid: statusBeforeAttach.pid,
    });
    expect(plan).toMatchObject({
      kind: 'external',
      port: existingGateway.port,
      pid: 4321,
      metadata: {
        processState: 'running',
        attachedToExistingGateway: true,
      },
    });
    expect(controlReadyProbe).not.toHaveBeenCalled();
    expect(manager.getStatus().processState).toBe('starting');
    expect(hoisted.prepareGatewayRuntimeBeforeLaunch).toHaveBeenCalledTimes(1);
    expect(hoisted.prepareGatewayRuntimeBeforeLaunch.mock.invocationCallOrder[0])
      .toBeLessThan(hoisted.findExistingGatewayProcess.mock.invocationCallOrder[0]);
    expect(hoisted.createGatewayLaunchContext).not.toHaveBeenCalled();
    expect(hoisted.buildGatewayLaunchPlan).not.toHaveBeenCalled();
  });

  it('stops an owned attached gateway through the external controller', async () => {
    hoisted.findExistingGatewayProcess.mockResolvedValueOnce({ port: 18789 });
    const { adapter, manager } = await createAdapterFixture();
    manager.markLaunched(4321);

    const plan = await adapter.prepareLaunch({ nowMs: () => 0, attempt: 1 });
    await adapter.externalController.stop?.();

    expect(plan).toMatchObject({ kind: 'external', pid: 4321 });
    expect(hoisted.terminateGatewayProcessIds).toHaveBeenCalledWith({
      port: 18789,
      pids: ['4321'],
      reason: 'owned attached gateway',
    });
  });

  it('projects local runtime auto-restart attempts into gateway reconnect status', async () => {
    const { adapter, manager } = await createAdapterFixture();

    await adapter.onAutoRestartScheduled({
      reason: 'restart-failed',
      attempt: 2,
      delayMs: 1000,
    });

    expect(manager.getStatus()).toMatchObject({
      processState: 'reconnecting',
      reconnectAttempts: 2,
    });
  });

  it('projects halted local runtime auto-restart into gateway error status', async () => {
    const { adapter, manager } = await createAdapterFixture();

    await adapter.onAutoRestartHalted({
      reason: 'restart-failed',
      maxAttempts: 6,
      windowMs: 60000,
    });

    expect(manager.getStatus()).toMatchObject({
      processState: 'error',
      error: 'Failed to reconnect after maximum attempts',
      reconnectAttempts: 6,
    });
  });

  it('attaches to an owned existing gateway with owned pid metadata', async () => {
    hoisted.findExistingGatewayProcess.mockResolvedValueOnce({
      port: 18789,
      externalToken: 'owned-token',
    });
    const { adapter, manager } = await createAdapterFixture();
    manager.markLaunched(7654);
    const statusBeforeAttach = manager.getStatus();

    const plan = await adapter.prepareLaunch({ nowMs: () => 0, attempt: 1 });

    expect(hoisted.findExistingGatewayProcess).toHaveBeenCalledWith({
      port: statusBeforeAttach.port,
      ownedPid: 7654,
    });
    expect(plan).toEqual({
      kind: 'external',
      port: 18789,
      pid: 7654,
      metadata: {
        processState: 'running',
        attachedToExistingGateway: true,
        externalToken: 'owned-token',
      },
    });
    expect(hoisted.createGatewayLaunchContext).not.toHaveBeenCalled();
    expect(hoisted.buildGatewayLaunchPlan).not.toHaveBeenCalled();
  });

  it('builds a LocalProcessRuntime utility launch plan for managed gateway startup', async () => {
    const { adapter, manager } = await createAdapterFixture();
    manager.setRuntimeHostManager({ onRuntimeJobEvent: () => () => {} } as never);

    const plan = await adapter.prepareLaunch({ nowMs: () => 0, attempt: 1 });

    expect(plan).toBe(managedPlan);
    expect(hoisted.warmupManagedPythonReadiness).toHaveBeenCalledTimes(1);
    expect(hoisted.prepareGatewayRuntimeBeforeLaunch).toHaveBeenCalledTimes(1);
    expect(hoisted.prepareGatewayRuntimeBeforeLaunch.mock.invocationCallOrder[0])
      .toBeLessThan(hoisted.findExistingGatewayProcess.mock.invocationCallOrder[0]);
    expect(hoisted.createGatewayLaunchContext).toHaveBeenCalledWith(
      18789,
      gatewayLaunchPlan,
      expect.anything(),
    );
    expect(hoisted.unloadLaunchctlGatewayService).toHaveBeenCalledTimes(1);
    expect(hoisted.buildGatewayLaunchPlan).toHaveBeenCalledWith({
      port: 18789,
      launchContext,
      sanitizeSpawnArgs: expect.any(Function),
    });
  });

  it('waits for port readiness before control readiness for managed gateway plans', async () => {
    const { adapter, delay, manager } = await createAdapterFixture();
    const controlReadyProbe = vi.fn(async () => {
      expect(manager.getStatus().processState).toBe('control_connecting');
    });
    manager.setControlReadyProbe(controlReadyProbe);

    await expect(adapter.probeReadiness(managedPlan)).resolves.toEqual({
      status: 'ready',
      detail: 'control channel ready',
    });

    expect(hoisted.waitForGatewayPortReady).toHaveBeenCalledWith({
      port: 18789,
      getProcessExitCode: expect.any(Function),
      signal: expect.any(AbortSignal),
    });
    expect(controlReadyProbe).toHaveBeenCalledTimes(1);
    expect(controlReadyProbe).toHaveBeenCalledWith(60000, 18789, undefined);
    expect(delay).not.toHaveBeenCalled();
  });

  it('does not leave a running manager stuck in control_connecting during readiness probes', async () => {
    const { adapter, manager } = await createAdapterFixture();
    const controlReadyProbe = vi.fn(async () => undefined);
    manager.setControlReadyProbe(controlReadyProbe);
    manager.markRunning();

    await expect(adapter.probeReadiness(managedPlan)).resolves.toEqual({
      status: 'ready',
      detail: 'control channel ready',
    });

    expect(hoisted.waitForGatewayPortReady).toHaveBeenCalledWith({
      port: 18789,
      getProcessExitCode: expect.any(Function),
      signal: expect.any(AbortSignal),
    });
    expect(controlReadyProbe).toHaveBeenCalledTimes(1);
    expect(controlReadyProbe).toHaveBeenCalledWith(60000, 18789, undefined);
    expect(manager.getStatus().processState).toBe('running');
  });

  it('retries readiness against the same external gateway after transient control failure', async () => {
    hoisted.findExistingGatewayProcess.mockResolvedValueOnce({ port: 18789 });
    const { adapter, delay, manager } = await createAdapterFixture();
    const controlReadyProbe = vi.fn()
      .mockRejectedValueOnce(new Error('Gateway socket closed before connect'))
      .mockResolvedValueOnce(undefined);
    manager.setControlReadyProbe(controlReadyProbe);
    const runtime = new LocalProcessRuntime({
      adapter,
      autoRestartOnCrash: false,
      startTimeoutMs: 100,
    });

    await runtime.start();

    expect(hoisted.findExistingGatewayProcess).toHaveBeenCalledTimes(1);
    expect(controlReadyProbe).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledWith(1000);
    expect(hoisted.prepareGatewayRuntimeBeforeLaunch).toHaveBeenCalledTimes(1);
    expect(hoisted.createGatewayLaunchContext).not.toHaveBeenCalled();
    expect(hoisted.buildGatewayLaunchPlan).not.toHaveBeenCalled();
    expect(runtime.getState().lifecycle).toBe('running');
  });

  it('reuses one prelaunch plan across managed start retries', async () => {
    const { adapter, manager } = await createAdapterFixture();
    manager.setRuntimeHostManager({ onRuntimeJobEvent: () => () => {} } as never);

    await adapter.prepareLaunch({ nowMs: () => 0, attempt: 1 });
    await adapter.prepareLaunch({ nowMs: () => 1, attempt: 2 });

    expect(hoisted.prepareGatewayRuntimeBeforeLaunch).toHaveBeenCalledTimes(1);
    expect(hoisted.createGatewayLaunchContext).toHaveBeenCalledTimes(2);
    expect(hoisted.createGatewayLaunchContext).toHaveBeenNthCalledWith(
      1,
      18789,
      gatewayLaunchPlan,
      expect.anything(),
    );
    expect(hoisted.createGatewayLaunchContext).toHaveBeenNthCalledWith(
      2,
      18789,
      gatewayLaunchPlan,
      expect.anything(),
    );
  });

  it('starts a new prelaunch for the next logical gateway start', async () => {
    const { adapter, manager } = await createAdapterFixture();
    manager.setRuntimeHostManager({ onRuntimeJobEvent: () => () => {} } as never);

    await adapter.prepareLaunch({ nowMs: () => 0, attempt: 1 });
    await adapter.prepareLaunch({ nowMs: () => 1, attempt: 1 });

    expect(hoisted.prepareGatewayRuntimeBeforeLaunch).toHaveBeenCalledTimes(2);
  });

  it('refreshes the completed prelaunch plan after doctor repair and consumes it for the managed retry', async () => {
    hoisted.runOpenClawDoctorRepair.mockResolvedValueOnce(true);
    hoisted.prepareGatewayRuntimeBeforeLaunch
      .mockResolvedValueOnce(gatewayLaunchPlan)
      .mockResolvedValueOnce(repairedGatewayLaunchPlan);
    const { adapter, manager } = await createAdapterFixture();
    manager.setRuntimeHostManager({ onRuntimeJobEvent: () => () => {} } as never);

    await adapter.prepareLaunch({ nowMs: () => 0, attempt: 1 });
    adapter.classifyLog('Config invalid. Run: openclaw doctor --fix', 'stderr');
    await expect(adapter.recoverStartFailure({
      error: new Error('Gateway process exited before becoming ready'),
      attempt: 1,
      plan: managedPlan,
      nowMs: () => 0,
      signal: new AbortController().signal,
    })).resolves.toEqual({ action: 'retry', cleanup: 'keep-current' });
    await adapter.prepareLaunch({ nowMs: () => 1, attempt: 2 });

    expect(hoisted.prepareGatewayRuntimeBeforeLaunch).toHaveBeenCalledTimes(2);
    expect(hoisted.createGatewayLaunchContext).toHaveBeenNthCalledWith(
      1,
      18789,
      gatewayLaunchPlan,
      expect.anything(),
    );
    expect(hoisted.createGatewayLaunchContext).toHaveBeenNthCalledWith(
      2,
      18789,
      repairedGatewayLaunchPlan,
      expect.anything(),
    );
  });

  it('retries prelaunch after its first RPC failure instead of reporting an unavailable launch plan', async () => {
    hoisted.prepareGatewayRuntimeBeforeLaunch
      .mockRejectedValueOnce(new Error('Gateway process exited before becoming ready: runtime-host prelaunch RPC unavailable'))
      .mockResolvedValueOnce(recoveredGatewayLaunchPlan);
    const { adapter, delay, manager } = await createAdapterFixture();
    manager.setRuntimeHostManager({ onRuntimeJobEvent: () => () => {} } as never);
    manager.setControlReadyProbe(vi.fn(async () => undefined));
    const utilityProcess = {
      pid: 8765,
      stdout: null,
      stderr: null,
      kill: vi.fn(() => true),
      once: vi.fn(() => utilityProcess),
    };
    const runtime = new LocalProcessRuntime({
      adapter,
      autoRestartOnCrash: false,
      startTimeoutMs: 100,
      utilityLauncher: { fork: vi.fn(async () => utilityProcess as never) },
    });

    await runtime.start();

    expect(delay).toHaveBeenCalledWith(1000);
    expect(hoisted.prepareGatewayRuntimeBeforeLaunch).toHaveBeenCalledTimes(2);
    expect(hoisted.createGatewayLaunchContext).toHaveBeenCalledWith(
      18789,
      recoveredGatewayLaunchPlan,
      expect.anything(),
    );
    expect(hoisted.buildGatewayLaunchPlan).toHaveBeenCalledTimes(1);
    expect(runtime.getState().lifecycle).toBe('running');
  });

  it('runs a new prelaunch for an explicit managed gateway restart', async () => {
    const { adapter, manager } = await createAdapterFixture();
    manager.setControlReadyProbe(vi.fn(async () => undefined));
    hoisted.buildGatewayLaunchPlan.mockReturnValue({
      plan: managedPlanWithDirectKill,
      lastSpawnSummary: 'mode=dev, entry="/tmp/openclaw/openclaw.mjs"',
    });

    const createUtilityProcess = (pid: number) => {
      const exitListeners: Array<(code: number) => void> = [];
      const utilityProcess = {
        pid,
        stdout: null,
        stderr: null,
        kill: vi.fn(() => {
          for (const listener of exitListeners) {
            listener(0);
          }
          return true;
        }),
        once: vi.fn((event: string, listener: (code: number) => void) => {
          if (event === 'exit') {
            exitListeners.push(listener);
          }
          return utilityProcess;
        }),
      };
      return utilityProcess;
    };
    const utilityFork = vi.fn()
      .mockResolvedValueOnce(createUtilityProcess(8765) as never)
      .mockResolvedValueOnce(createUtilityProcess(8766) as never);
    const runtime = new LocalProcessRuntime({
      adapter,
      autoRestartOnCrash: false,
      startTimeoutMs: 100,
      stopTimeoutMs: 1,
      utilityLauncher: { fork: utilityFork },
    });

    await runtime.start();
    await runtime.restart();

    expect(hoisted.prepareGatewayRuntimeBeforeLaunch).toHaveBeenCalledTimes(2);
    expect(utilityFork).toHaveBeenCalledTimes(2);
    expect(runtime.getState()).toMatchObject({ lifecycle: 'running', pid: 8766 });
  });

  it('retries transient managed readiness with the original child and launch plan', async () => {
    hoisted.buildGatewayLaunchPlan.mockReturnValue({
      plan: managedPlanWithDirectKill,
      lastSpawnSummary: 'mode=dev, entry="/tmp/openclaw/openclaw.mjs"',
    });
    const { adapter, delay, manager } = await createAdapterFixture();
    manager.setRuntimeHostManager({ onRuntimeJobEvent: () => () => {} } as never);
    const controlReadyProbe = vi.fn()
      .mockRejectedValueOnce(new Error('Connect handshake timeout'))
      .mockResolvedValueOnce(undefined);
    manager.setControlReadyProbe(controlReadyProbe);
    const utilityProcess = {
      pid: 8765,
      stdout: null,
      stderr: null,
      kill: vi.fn(() => true),
      once: vi.fn(() => utilityProcess),
    };
    const utilityFork = vi.fn(async () => utilityProcess as never);
    const runtime = new LocalProcessRuntime({
      adapter,
      autoRestartOnCrash: false,
      startTimeoutMs: 100,
      stopTimeoutMs: 1,
      utilityLauncher: { fork: utilityFork },
    });

    await runtime.start();

    expect(hoisted.findExistingGatewayProcess).toHaveBeenCalledTimes(1);
    expect(controlReadyProbe).toHaveBeenCalledTimes(2);
    expect(controlReadyProbe).toHaveBeenNthCalledWith(1, 60000, 18789, undefined);
    expect(controlReadyProbe).toHaveBeenNthCalledWith(2, 60000, 18789, undefined);
    expect(delay).toHaveBeenCalledWith(1000);
    expect(utilityFork).toHaveBeenCalledTimes(1);
    expect(hoisted.createGatewayLaunchContext).toHaveBeenCalledTimes(1);
    expect(hoisted.buildGatewayLaunchPlan).toHaveBeenCalledTimes(1);
    expect(utilityProcess.kill).not.toHaveBeenCalled();
    expect(runtime.getState()).toMatchObject({ lifecycle: 'running', pid: 8765 });
    expect(manager.getStatus()).toMatchObject({ processState: 'running', pid: 8765 });
  });

  it('rejects the active start when the managed child exits during pending readiness', async () => {
    hoisted.buildGatewayLaunchPlan.mockReturnValue({
      plan: managedPlanWithDirectKill,
      lastSpawnSummary: 'mode=dev, entry="/tmp/openclaw/openclaw.mjs"',
    });
    const { adapter, manager } = await createAdapterFixture();
    manager.setRuntimeHostManager({ onRuntimeJobEvent: () => () => {} } as never);
    let exitListener: ((code: number) => void) | undefined;
    const utilityProcess = {
      pid: 8765,
      stdout: null,
      stderr: null,
      kill: vi.fn(() => true),
      once: vi.fn((event: string, listener: (code: number) => void) => {
        if (event === 'exit') {
          exitListener = listener;
        }
        return utilityProcess;
      }),
    };
    const utilityFork = vi.fn(async () => utilityProcess as never);
    const controlReadyProbe = vi.fn(async () => {
      exitListener?.(1);
      throw new Error('unexpected control transport failure');
    });
    manager.setControlReadyProbe(controlReadyProbe);
    const runtime = new LocalProcessRuntime({
      adapter,
      autoRestartOnCrash: false,
      startTimeoutMs: 100,
      stopTimeoutMs: 1,
      utilityLauncher: { fork: utilityFork },
    });

    await expect(runtime.start()).rejects.toThrow(
      'OpenClaw gateway exited unexpectedly (code=1, signal=null)',
    );

    expect(hoisted.findExistingGatewayProcess).toHaveBeenCalledTimes(1);
    expect(controlReadyProbe).toHaveBeenCalledTimes(1);
    expect(utilityFork).toHaveBeenCalledTimes(1);
    expect(hoisted.createGatewayLaunchContext).toHaveBeenCalledTimes(1);
    expect(hoisted.buildGatewayLaunchPlan).toHaveBeenCalledTimes(1);
    expect(utilityProcess.kill).not.toHaveBeenCalled();
    expect(runtime.getState()).toMatchObject({
      lifecycle: 'error',
      lastError: 'OpenClaw gateway exited unexpectedly (code=1, signal=null)',
    });
  });

  it('propagates a managed control-ready error without an adapter wrapper or outer recovery', async () => {
    hoisted.buildGatewayLaunchPlan.mockReturnValue({
      plan: managedPlanWithDirectKill,
      lastSpawnSummary: 'mode=dev, entry="/tmp/openclaw/openclaw.mjs"',
    });
    const { adapter, delay, manager } = await createAdapterFixture();
    manager.setRuntimeHostManager({ onRuntimeJobEvent: () => () => {} } as never);
    const controlReadyProbe = vi.fn(async () => {
      throw new Error('unexpected control transport failure');
    });
    manager.setControlReadyProbe(controlReadyProbe);
    const utilityProcess = {
      pid: 4567,
      stdout: null,
      stderr: null,
      kill: vi.fn(() => true),
      once: vi.fn(() => utilityProcess),
    };
    const utilityFork = vi.fn(async () => utilityProcess as never);
    const runtime = new LocalProcessRuntime({
      adapter,
      autoRestartOnCrash: false,
      startTimeoutMs: 100,
      stopTimeoutMs: 1,
      utilityLauncher: { fork: utilityFork },
    });

    await expect(runtime.start()).rejects.toThrow('unexpected control transport failure');

    expect(hoisted.findExistingGatewayProcess).toHaveBeenCalledTimes(1);
    expect(controlReadyProbe).toHaveBeenCalledOnce();
    expect(controlReadyProbe).toHaveBeenCalledWith(60000, 18789, undefined);
    expect(delay).not.toHaveBeenCalled();
    expect(utilityFork).toHaveBeenCalledTimes(1);
    expect(hoisted.createGatewayLaunchContext).toHaveBeenCalledTimes(1);
    expect(hoisted.buildGatewayLaunchPlan).toHaveBeenCalledTimes(1);
    expect(utilityProcess.kill).not.toHaveBeenCalled();
    expect(hoisted.terminateGatewayProcessIds).not.toHaveBeenCalled();
    expect(runtime.getState()).toMatchObject({
      lifecycle: 'error',
      pid: 4567,
      lastError: 'unexpected control transport failure',
    });
    expect(manager.getStatus()).toMatchObject({
      processState: 'error',
      pid: 4567,
      error: 'unexpected control transport failure',
    });
  });

  it.each([
    ['transport handshake', 'Gateway connect failed: gateway starting; retry shortly'],
    ['service liveness', 'Gateway RPC timeout: system-presence'],
  ])('waits through %s starting within one control-ready budget before outer retry', async (_phase, error) => {
    hoisted.buildGatewayLaunchPlan.mockReturnValue({
      plan: managedPlanWithDirectKill,
      lastSpawnSummary: 'mode=dev, entry="/tmp/openclaw/openclaw.mjs"',
    });
    const { adapter, delay, manager } = await createAdapterFixture();
    const runtimeHostEndpoint = {
      kind: 'native-runtime',
      runtimeAdapterId: 'openclaw',
      runtimeInstanceId: 'local',
    };
    const controlReadyExecute = vi.fn()
      .mockResolvedValueOnce({
        data: {
          success: false,
          phase: 'starting',
          retryable: true,
          retryAfterMs: 60_000,
          error,
        },
      })
      .mockResolvedValueOnce({ data: { success: true, phase: 'ready' } });
    const runtimeHostRequest = vi.fn(async (_method: string, route: string) => {
      if (route === '/api/runtime-endpoints/list') {
        return {
          data: {
            endpoints: [{
              id: 'openclaw-local',
              runtimeAdapterId: 'openclaw',
              runtimeInstanceId: 'local',
              capabilitySummaries: [{ id: 'runtime.host', availability: 'available' }],
            }],
          },
        };
      }
      if (route === '/api/capabilities/list') {
        return {
          data: {
            capabilities: [{
              id: 'runtime.host',
              availability: 'available',
              scope: { kind: 'runtime-instance', endpoint: runtimeHostEndpoint },
            }],
          },
        };
      }
      return await controlReadyExecute();
    });
    let controlReadyNow = 0;
    const controlReadyDelay = vi.fn(async (ms: number) => {
      controlReadyNow += ms;
    });
    manager.setRuntimeHostManager({
      request: runtimeHostRequest,
      onRuntimeJobEvent: () => () => {},
    } as never);
    manager.setControlReadyProbe((timeoutMs, port) => waitForGatewayControlReady({
      runtimeHostManager: manager.getRuntimeHostManager(),
      nowMs: () => controlReadyNow,
      delay: controlReadyDelay,
    }, timeoutMs, port));
    const utilityProcess = {
      pid: 4567,
      stdout: null,
      stderr: null,
      kill: vi.fn(() => true),
      once: vi.fn(() => utilityProcess),
    };
    const utilityFork = vi.fn(async () => utilityProcess as never);
    const runtime = new LocalProcessRuntime({
      adapter,
      autoRestartOnCrash: false,
      startTimeoutMs: 100,
      stopTimeoutMs: 1,
      utilityLauncher: { fork: utilityFork },
    });

    await runtime.start();

    expect(controlReadyExecute).toHaveBeenCalledTimes(2);
    expect(controlReadyDelay).toHaveBeenCalledTimes(1);
    expect(controlReadyDelay).toHaveBeenCalledWith(60_000);
    expect(controlReadyNow).toBe(60_000);
    expect(delay).toHaveBeenCalledOnce();
    expect(delay).toHaveBeenCalledWith(1000);
    expect(utilityFork).toHaveBeenCalledTimes(1);
    expect(hoisted.prepareGatewayRuntimeBeforeLaunch).toHaveBeenCalledTimes(1);
    expect(hoisted.findExistingGatewayProcess).toHaveBeenCalledTimes(1);
    expect(hoisted.createGatewayLaunchContext).toHaveBeenCalledTimes(1);
    expect(hoisted.buildGatewayLaunchPlan).toHaveBeenCalledTimes(1);
    expect(utilityProcess.kill).not.toHaveBeenCalled();
    expect(runtime.getState()).toMatchObject({ lifecycle: 'running', pid: 4567 });
  });

  it('drops OpenClaw gateway stdout to preserve the old stderr-only log policy', async () => {
    const { adapter } = await createAdapterFixture();

    expect(adapter.classifyLog(
      '2026-07-07T19:44:37.952+08:00 [ws] ⇄ res ✓ health 740ms cached=true',
      'stdout',
    )).toEqual({
      level: 'drop',
      message: '2026-07-07T19:44:37.952+08:00 [ws] ⇄ res ✓ health 740ms cached=true',
    });
    expect(adapter.classifyLog('[gateway] ready', 'stdout')).toEqual({
      level: 'drop',
      message: '[gateway] ready',
    });
  });

  it('does not use stdout lines as startup stderr recovery signals', async () => {
    const { adapter } = await createAdapterFixture();
    adapter.classifyLog('Config invalid. Run: openclaw doctor --fix', 'stdout');

    await expect(adapter.recoverStartFailure({
      error: new Error('Gateway process exited before becoming ready'),
      attempt: 1,
      plan: managedPlan,
      nowMs: () => 0,
      signal: new AbortController().signal,
    })).resolves.toEqual({ action: 'retry', cleanup: 'keep-current' });

    expect(hoisted.runOpenClawDoctorRepair).not.toHaveBeenCalled();
  });

  it('keeps the current gateway process for transient startup failures', async () => {
    const { adapter, delay, manager } = await createAdapterFixture();

    await expect(adapter.recoverStartFailure({
      error: new Error('Connect handshake timeout'),
      attempt: 1,
      plan: managedPlan,
      nowMs: () => 0,
      signal: new AbortController().signal,
    })).resolves.toEqual({
      action: 'retry',
      cleanup: 'keep-current',
    });

    expect(delay).toHaveBeenCalledWith(1000);
    expect(hoisted.runOpenClawDoctorRepair).not.toHaveBeenCalled();
    expect(manager.getStatus().processState).not.toBe('error');
  });

  it('keeps stderr warning and repeat suppression semantics', async () => {
    const { adapter } = await createAdapterFixture();

    expect(adapter.classifyLog('first warning', 'stderr')).toEqual({
      level: 'warn',
      message: 'first warning',
    });
    expect(adapter.classifyLog('first warning', 'stderr')).toEqual({
      level: 'drop',
      message: 'first warning',
    });
  });

  it('repairs invalid OpenClaw config once before retrying startup', async () => {
    hoisted.runOpenClawDoctorRepair.mockResolvedValueOnce(true);
    const { adapter } = await createAdapterFixture();
    adapter.classifyLog('Config invalid. Run: openclaw doctor --fix', 'stderr');

    await expect(adapter.recoverStartFailure({
      error: new Error('Gateway process exited before becoming ready'),
      attempt: 1,
      plan: managedPlan,
      nowMs: () => 0,
      signal: new AbortController().signal,
    })).resolves.toEqual({ action: 'retry', cleanup: 'keep-current' });

    expect(hoisted.runOpenClawDoctorRepair).toHaveBeenCalledTimes(1);
  });

  it('does not repeat invalid OpenClaw config repair in the same startup flow', async () => {
    hoisted.runOpenClawDoctorRepair.mockResolvedValueOnce(true);
    const { adapter } = await createAdapterFixture();
    const context = {
      error: new Error('Gateway process exited before becoming ready'),
      plan: managedPlan,
      nowMs: () => 0,
      signal: new AbortController().signal,
    };

    adapter.classifyLog('Config invalid. Run: openclaw doctor --fix', 'stderr');
    await expect(adapter.recoverStartFailure({
      ...context,
      attempt: 1,
    })).resolves.toEqual({ action: 'retry', cleanup: 'keep-current' });

    adapter.classifyLog('Config invalid. Run: openclaw doctor --fix', 'stderr');
    await expect(adapter.recoverStartFailure({
      ...context,
      attempt: 2,
    })).resolves.toEqual({ action: 'retry', cleanup: 'keep-current' });

    expect(hoisted.runOpenClawDoctorRepair).toHaveBeenCalledTimes(1);
  });
});
