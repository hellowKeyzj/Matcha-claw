import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createQuitLifecycleState,
  markQuitCleanupCompleted,
  requestQuitLifecycleAction,
} from '@electron/main/quit-lifecycle';

const hoisted = vi.hoisted(() => {
  const appHandlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const mainWindowMock = {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    isVisible: vi.fn(() => true),
    once: vi.fn(),
  };
  const hostApiServerMock = {
    close: vi.fn(),
  };
  const electronAppMock = {
    disableHardwareAcceleration: vi.fn(),
    setDesktopName: vi.fn(),
    setPath: vi.fn(),
    requestSingleInstanceLock: vi.fn(() => true),
    exit: vi.fn(),
    getPath: vi.fn(() => '/tmp/matchaclaw'),
    whenReady: vi.fn(() => Promise.resolve()),
    on: vi.fn((eventName: string, handler: (...args: unknown[]) => void) => {
      const handlers = appHandlers.get(eventName) ?? [];
      handlers.push(handler);
      appHandlers.set(eventName, handlers);
    }),
    setAppUserModelId: vi.fn(),
    quit: vi.fn(),
    isPackaged: false,
    getVersion: vi.fn(() => '0.0.0-test'),
    getName: vi.fn(() => 'MatchaClaw'),
  };
  const hostEventBusInstances: Array<{ closeAll: ReturnType<typeof vi.fn> }> = [];
  const gatewayManagerInstances: Array<{
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    restart: ReturnType<typeof vi.fn>;
  }> = [];
  const runtimeHostManagerMock = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    restart: vi.fn(async () => undefined),
    forceTerminate: vi.fn(async () => undefined),
    checkHealth: vi.fn(async () => ({ ok: true, lifecycle: 'running', activePluginCount: 0, degradedPlugins: [] })),
    getState: vi.fn(() => ({ lifecycle: 'running', runtimeLifecycle: 'running', activePluginCount: 0 })),
    onStateChange: vi.fn(() => () => undefined),
    request: vi.fn(),
    readGatewayStatus: vi.fn(),
    executeShellAction: vi.fn(),
    emitGatewayEvent: vi.fn(),
    onGatewayEvent: vi.fn(() => () => undefined),
    emitRuntimeJobEvent: vi.fn(),
    onRuntimeJobEvent: vi.fn(() => () => undefined),
    getInternalDispatchToken: vi.fn(() => 'test-token'),
  };
  const gatewayProcessRunnerMock = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    restart: vi.fn(async () => undefined),
    forceTerminate: vi.fn(async () => undefined),
    checkReadiness: vi.fn(async () => ({ status: 'ready' })),
    getState: vi.fn(() => ({ lifecycle: 'running' })),
    onStateChange: vi.fn(() => () => undefined),
  };
  const matchaAgentAppServerManagerMock = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    restart: vi.fn(async () => undefined),
    forceTerminate: vi.fn(async () => undefined),
    checkReadiness: vi.fn(async () => ({ status: 'ready' })),
    getState: vi.fn(() => ({ lifecycle: 'running' })),
    getEndpointSnapshot: vi.fn(() => undefined),
    onStateChange: vi.fn(() => () => undefined),
  };
  const bootstrapMainApplicationMock = vi.fn(async () => ({
    mainWindow: mainWindowMock,
    hostApiServer: hostApiServerMock,
  }));
  const loggerMock = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  return {
    appHandlers,
    electronAppMock,
    mainWindowMock,
    hostApiServerMock,
    hostEventBusInstances,
    gatewayManagerInstances,
    runtimeHostManagerMock,
    gatewayProcessRunnerMock,
    matchaAgentAppServerManagerMock,
    bootstrapMainApplicationMock,
    loggerMock,
  };
});

vi.mock('electron', () => ({
  app: hoisted.electronAppMock,
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
}));

vi.mock('@electron/main/process-runtime/openclaw-gateway/manager', () => ({
  GatewayManager: class {
    private processController: typeof hoisted.gatewayProcessRunnerMock | undefined;

    start = vi.fn(async () => {
      await this.processController?.start();
    });
    stop = vi.fn(async () => undefined);
    restart = vi.fn(async () => {
      await this.processController?.restart();
      return { status: 'restarted' as const };
    });
    setRuntimeHostManager = vi.fn();
    setControlReadyProbe = vi.fn();
    setProcessController = vi.fn((controller: typeof hoisted.gatewayProcessRunnerMock) => {
      this.processController = controller;
    });

    constructor() {
      hoisted.gatewayManagerInstances.push(this);
    }
  },
}));

vi.mock('@electron/utils/logger', () => ({
  logger: hoisted.loggerMock,
}));

vi.mock('@electron/api/event-bus', () => ({
  HostEventBus: class {
    closeAll = vi.fn();

    constructor() {
      hoisted.hostEventBusInstances.push(this);
    }
  },
}));

function mockProcessManagersForMainIndex(): void {
  vi.doMock('@electron/main/runtime-host-manager', () => ({
    createRuntimeHostManager: vi.fn(() => hoisted.runtimeHostManagerMock),
  }));
  vi.doMock('@electron/main/process-runtime/matcha-agent-app-server-process-manager', () => ({
    createMatchaAgentAppServerProcessManager: vi.fn(() => hoisted.matchaAgentAppServerManagerMock),
  }));
  vi.doMock('@electron/main/process-runtime/openclaw-gateway-process-manager', () => ({
    createOpenClawGatewayProcessManager: vi.fn(() => hoisted.gatewayProcessRunnerMock),
  }));
}

vi.mock('@electron/main/app-bootstrap', () => ({
  bootstrapMainApplication: (...args: unknown[]) => hoisted.bootstrapMainApplicationMock(...args),
}));

vi.mock('@electron/main/main-window', () => ({
  createMainWindow: vi.fn(() => hoisted.mainWindowMock),
  loadMainWindowContent: vi.fn(),
}));

vi.mock('@electron/main/process-instance-lock', () => ({
  acquireProcessInstanceFileLock: vi.fn(() => ({
    acquired: true,
    release: vi.fn(),
  })),
}));

vi.mock('@electron/main/gateway-control-ready-probe', () => ({
  waitForGatewayControlReady: vi.fn(async () => undefined),
}));

type ProcessListener = Parameters<typeof process.removeListener>[1];
type ProcessListenerSnapshot = Record<'exit' | 'SIGINT' | 'SIGTERM', ProcessListener[]>;

function snapshotProcessListeners(): ProcessListenerSnapshot {
  return {
    exit: process.listeners('exit') as ProcessListener[],
    SIGINT: process.listeners('SIGINT') as ProcessListener[],
    SIGTERM: process.listeners('SIGTERM') as ProcessListener[],
  };
}

function restoreProcessListeners(snapshot: ProcessListenerSnapshot): void {
  for (const eventName of Object.keys(snapshot) as Array<keyof ProcessListenerSnapshot>) {
    const originalListeners = new Set(snapshot[eventName]);
    for (const listener of process.listeners(eventName)) {
      if (!originalListeners.has(listener)) {
        process.removeListener(eventName, listener);
      }
    }
  }
}

async function importMainIndex(): Promise<ProcessListenerSnapshot> {
  const processListeners = snapshotProcessListeners();
  await import('@electron/main/index');
  await Promise.resolve();
  await Promise.resolve();
  return processListeners;
}

function dispatchBeforeQuit(): { preventDefault: ReturnType<typeof vi.fn> } {
  const handler = hoisted.appHandlers.get('before-quit')?.[0];
  expect(handler).toBeTypeOf('function');
  const event = { preventDefault: vi.fn() };
  handler?.(event);
  return event;
}

describe('main quit lifecycle coordination', () => {
  let processListeners: ProcessListenerSnapshot | undefined;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockProcessManagersForMainIndex();
    hoisted.appHandlers.clear();
    hoisted.hostEventBusInstances.length = 0;
    hoisted.gatewayManagerInstances.length = 0;
    hoisted.electronAppMock.whenReady.mockReturnValue(Promise.resolve());
    hoisted.runtimeHostManagerMock.stop.mockResolvedValue(undefined);
    hoisted.runtimeHostManagerMock.forceTerminate.mockResolvedValue(undefined);
    hoisted.gatewayProcessRunnerMock.stop.mockResolvedValue(undefined);
    hoisted.gatewayProcessRunnerMock.forceTerminate.mockResolvedValue(undefined);
    hoisted.matchaAgentAppServerManagerMock.stop.mockResolvedValue(undefined);
    hoisted.matchaAgentAppServerManagerMock.forceTerminate.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (processListeners) {
      restoreProcessListeners(processListeners);
      processListeners = undefined;
    }
    vi.useRealTimers();
  });

  it('starts cleanup only once', () => {
    const state = createQuitLifecycleState();

    expect(requestQuitLifecycleAction(state)).toBe('start-cleanup');
    expect(requestQuitLifecycleAction(state)).toBe('cleanup-in-progress');
  });

  it('allows quit after cleanup is marked complete', () => {
    const state = createQuitLifecycleState();

    expect(requestQuitLifecycleAction(state)).toBe('start-cleanup');
    markQuitCleanupCompleted(state);
    expect(requestQuitLifecycleAction(state)).toBe('allow-quit');
  });

  it('closes host events/server and stops all app-owned processes without force termination before the timeout', async () => {
    vi.useFakeTimers();
    processListeners = await importMainIndex();

    const event = dispatchBeforeQuit();

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(hoisted.hostEventBusInstances[0]?.closeAll).toHaveBeenCalledTimes(1);
    expect(hoisted.hostApiServerMock.close).toHaveBeenCalledTimes(1);
    expect(hoisted.runtimeHostManagerMock.stop).toHaveBeenCalledTimes(1);
    expect(hoisted.gatewayManagerInstances[0]?.stop).toHaveBeenCalledTimes(1);
    expect(hoisted.matchaAgentAppServerManagerMock.stop).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(0);

    expect(hoisted.runtimeHostManagerMock.forceTerminate).not.toHaveBeenCalled();
    expect(hoisted.gatewayProcessRunnerMock.forceTerminate).not.toHaveBeenCalled();
    expect(hoisted.matchaAgentAppServerManagerMock.forceTerminate).not.toHaveBeenCalled();
    expect(hoisted.electronAppMock.quit).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000);

    expect(hoisted.runtimeHostManagerMock.forceTerminate).not.toHaveBeenCalled();
    expect(hoisted.gatewayProcessRunnerMock.forceTerminate).not.toHaveBeenCalled();
    expect(hoisted.matchaAgentAppServerManagerMock.forceTerminate).not.toHaveBeenCalled();
    expect(hoisted.electronAppMock.quit).toHaveBeenCalledTimes(1);
  });

  it('guards process starts and restarts once quit cleanup has started', async () => {
    processListeners = await importMainIndex();
    await Promise.resolve();
    const bootstrapArgs = hoisted.bootstrapMainApplicationMock.mock.calls[0]?.[0] as {
      gatewayManager: {
        start: () => Promise<void>;
        restart: () => Promise<{ status: 'restarted' | 'deferred' }>;
      };
      runtimeHostManager: typeof hoisted.runtimeHostManagerMock;
      matchaAgentAppServerManager: typeof hoisted.matchaAgentAppServerManagerMock;
    };
    expect(bootstrapArgs).toBeTruthy();

    dispatchBeforeQuit();
    await bootstrapArgs.runtimeHostManager.start();
    await bootstrapArgs.runtimeHostManager.restart();
    await bootstrapArgs.gatewayManager.start();
    await bootstrapArgs.gatewayManager.restart();
    await bootstrapArgs.matchaAgentAppServerManager.start();
    await bootstrapArgs.matchaAgentAppServerManager.restart();

    expect(hoisted.runtimeHostManagerMock.start).not.toHaveBeenCalled();
    expect(hoisted.runtimeHostManagerMock.restart).not.toHaveBeenCalled();
    expect(hoisted.gatewayProcessRunnerMock.start).not.toHaveBeenCalled();
    expect(hoisted.gatewayProcessRunnerMock.restart).not.toHaveBeenCalled();
    expect(hoisted.matchaAgentAppServerManagerMock.start).not.toHaveBeenCalled();
    expect(hoisted.matchaAgentAppServerManagerMock.restart).not.toHaveBeenCalled();
    expect(hoisted.loggerMock.debug).toHaveBeenCalledWith(
      '[quit] Skip OpenClaw gateway start because quit cleanup is in progress',
    );
  });

  it('force terminates all registered owned processes once and waits for every emergency cleanup to settle', async () => {
    vi.useFakeTimers();
    let resolveRuntimeHostForceTerminate!: () => void;
    const runtimeHostForceTerminatePromise = new Promise<void>((resolve) => {
      resolveRuntimeHostForceTerminate = resolve;
    });
    hoisted.runtimeHostManagerMock.stop.mockReturnValue(new Promise(() => undefined));
    hoisted.runtimeHostManagerMock.forceTerminate.mockReturnValue(runtimeHostForceTerminatePromise);
    hoisted.gatewayProcessRunnerMock.stop.mockReturnValue(new Promise(() => undefined));
    hoisted.gatewayProcessRunnerMock.forceTerminate.mockRejectedValue(new Error('gateway force terminate failed'));
    hoisted.matchaAgentAppServerManagerMock.stop.mockReturnValue(new Promise(() => undefined));
    processListeners = await importMainIndex();

    const firstEvent = dispatchBeforeQuit();
    const secondEvent = dispatchBeforeQuit();

    expect(firstEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(secondEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(hoisted.runtimeHostManagerMock.stop).toHaveBeenCalledTimes(1);
    expect(hoisted.gatewayManagerInstances[0]?.stop).toHaveBeenCalledTimes(1);
    expect(hoisted.matchaAgentAppServerManagerMock.stop).toHaveBeenCalledTimes(1);
    expect(hoisted.runtimeHostManagerMock.forceTerminate).not.toHaveBeenCalled();
    expect(hoisted.gatewayProcessRunnerMock.forceTerminate).not.toHaveBeenCalled();
    expect(hoisted.matchaAgentAppServerManagerMock.forceTerminate).not.toHaveBeenCalled();
    expect(hoisted.electronAppMock.quit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(4999);

    expect(hoisted.runtimeHostManagerMock.forceTerminate).not.toHaveBeenCalled();
    expect(hoisted.gatewayProcessRunnerMock.forceTerminate).not.toHaveBeenCalled();
    expect(hoisted.matchaAgentAppServerManagerMock.forceTerminate).not.toHaveBeenCalled();
    expect(hoisted.electronAppMock.quit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(hoisted.runtimeHostManagerMock.stop).toHaveBeenCalledTimes(1);
    expect(hoisted.gatewayManagerInstances[0]?.stop).toHaveBeenCalledTimes(1);
    expect(hoisted.matchaAgentAppServerManagerMock.stop).toHaveBeenCalledTimes(1);
    expect(hoisted.runtimeHostManagerMock.forceTerminate).toHaveBeenCalledTimes(1);
    expect(hoisted.gatewayProcessRunnerMock.forceTerminate).toHaveBeenCalledTimes(1);
    expect(hoisted.matchaAgentAppServerManagerMock.forceTerminate).toHaveBeenCalledTimes(1);
    expect(hoisted.electronAppMock.quit).not.toHaveBeenCalled();

    resolveRuntimeHostForceTerminate();
    await vi.waitFor(() => {
      expect(hoisted.electronAppMock.quit).toHaveBeenCalledTimes(1);
    });

    const thirdEvent = dispatchBeforeQuit();

    expect(thirdEvent.preventDefault).not.toHaveBeenCalled();
    expect(hoisted.hostEventBusInstances[0]?.closeAll).toHaveBeenCalledTimes(1);
    expect(hoisted.hostApiServerMock.close).toHaveBeenCalledTimes(1);
    expect(hoisted.runtimeHostManagerMock.stop).toHaveBeenCalledTimes(1);
    expect(hoisted.gatewayManagerInstances[0]?.stop).toHaveBeenCalledTimes(1);
    expect(hoisted.matchaAgentAppServerManagerMock.stop).toHaveBeenCalledTimes(1);
    expect(hoisted.runtimeHostManagerMock.forceTerminate).toHaveBeenCalledTimes(1);
    expect(hoisted.gatewayProcessRunnerMock.forceTerminate).toHaveBeenCalledTimes(1);
    expect(hoisted.matchaAgentAppServerManagerMock.forceTerminate).toHaveBeenCalledTimes(1);
    expect(hoisted.electronAppMock.quit).toHaveBeenCalledTimes(1);
  });
});
