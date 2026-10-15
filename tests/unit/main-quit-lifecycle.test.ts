import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createQuitLifecycleState,
  markQuitCleanupCompleted,
  requestQuitLifecycleAction,
} from '@electron/main/quit-lifecycle';

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
  const electronAppMock = {
    commandLine: { appendSwitch: vi.fn() },
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
  const closeApplicationMock = vi.fn(async () => undefined);
  const bootstrapMainApplicationMock = vi.fn(() => ({
    mainWindow: mainWindowMock,
    ready: Promise.resolve(),
    close: closeApplicationMock,
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
    hostEventBusInstances,
    closeApplicationMock,
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

vi.mock('@electron/main/app-bootstrap', () => ({
  bootstrapMainApplication: (...args: unknown[]) => hoisted.bootstrapMainApplicationMock(...args),
}));

vi.mock('@electron/main/main-window', () => ({
  createMainWindow: vi.fn(),
  loadMainWindowContent: vi.fn(),
}));

vi.mock('@electron/main/process-instance-lock', () => ({
  acquireProcessInstanceFileLock: vi.fn(() => ({
    acquired: true,
    release: vi.fn(),
  })),
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
    hoisted.appHandlers.clear();
    hoisted.hostEventBusInstances.length = 0;
    hoisted.electronAppMock.isPackaged = false;
    hoisted.electronAppMock.whenReady.mockReturnValue(Promise.resolve());
    hoisted.closeApplicationMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (processListeners) {
      restoreProcessListeners(processListeners);
      processListeners = undefined;
    }
    restorePlatform();
    vi.useRealTimers();
  });

  it('does not set a Windows identity in development', async () => {
    setPlatform('win32');
    processListeners = await importMainIndex();

    expect(hoisted.electronAppMock.setAppUserModelId).not.toHaveBeenCalled();
  });

  it('uses the installer identity in packaged builds', async () => {
    setPlatform('win32');
    hoisted.electronAppMock.isPackaged = true;
    processListeners = await importMainIndex();

    expect(hoisted.electronAppMock.setAppUserModelId).toHaveBeenCalledWith('app.MatchaClaw.desktop');
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

  it('keeps only DirectRuntimeHost as the main-process peer runtime owner', async () => {
    processListeners = await importMainIndex();

    expect(hoisted.bootstrapMainApplicationMock).toHaveBeenCalledWith(expect.objectContaining({
      hostEventBus: expect.anything(),
    }));
    expect(hoisted.bootstrapMainApplicationMock.mock.calls[0]?.[0]).not.toHaveProperty('gatewayManager');
    expect(hoisted.bootstrapMainApplicationMock.mock.calls[0]?.[0]).not.toHaveProperty('runtimeHostManager');
    expect(hoisted.bootstrapMainApplicationMock.mock.calls[0]?.[0]).not.toHaveProperty('matchaAgentAppServerManager');
  });

  it('E2E bootstrap failure keeps the process available and logs no raw error', async () => {
    process.env.MATCHACLAW_E2E = '1';
    const failure = new Error('C:\\private\\runtime-host.exe token');
    hoisted.bootstrapMainApplicationMock.mockImplementationOnce(() => ({
      mainWindow: hoisted.mainWindowMock,
      ready: Promise.reject(failure),
      close: hoisted.closeApplicationMock,
    }));

    processListeners = await importMainIndex();

    expect(hoisted.electronAppMock.quit).not.toHaveBeenCalled();
    expect(hoisted.loggerMock.error).toHaveBeenCalledWith('Failed to bootstrap main application');
    expect(hoisted.loggerMock.error).not.toHaveBeenCalledWith(expect.anything(), failure);
  });

  it('closes shell resources and awaits application cleanup before quitting', async () => {
    let resolveClose!: () => void;
    hoisted.closeApplicationMock.mockReturnValue(new Promise<void>((resolve) => { resolveClose = resolve; }));
    processListeners = await importMainIndex();

    const event = dispatchBeforeQuit();

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(hoisted.hostEventBusInstances[0]?.closeAll).toHaveBeenCalledTimes(1);
    expect(hoisted.closeApplicationMock).toHaveBeenCalledTimes(1);
    expect(hoisted.electronAppMock.quit).not.toHaveBeenCalled();

    resolveClose();
    await vi.waitFor(() => expect(hoisted.electronAppMock.quit).toHaveBeenCalledTimes(1));
  });

  it('logs settled application cleanup failure and still permits quitting', async () => {
    const failure = new Error('application cleanup failed');
    hoisted.closeApplicationMock.mockRejectedValue(failure);
    processListeners = await importMainIndex();

    dispatchBeforeQuit();
    await vi.waitFor(() => expect(hoisted.electronAppMock.quit).toHaveBeenCalledTimes(1));
    expect(hoisted.loggerMock.warn).toHaveBeenCalledWith('Failed to close main application during quit:', failure);
    const secondEvent = dispatchBeforeQuit();

    expect(secondEvent.preventDefault).not.toHaveBeenCalled();
    expect(hoisted.closeApplicationMock).toHaveBeenCalledTimes(1);
    expect(hoisted.electronAppMock.quit).toHaveBeenCalledTimes(1);
  });

  it('joins repeated quit requests until the single application cleanup completes', async () => {
    let resolveClose!: () => void;
    hoisted.closeApplicationMock.mockReturnValue(new Promise<void>((resolve) => { resolveClose = resolve; }));
    processListeners = await importMainIndex();

    const firstEvent = dispatchBeforeQuit();
    const secondEvent = dispatchBeforeQuit();

    expect(firstEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(secondEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(hoisted.closeApplicationMock).toHaveBeenCalledTimes(1);
    expect(hoisted.electronAppMock.quit).not.toHaveBeenCalled();

    resolveClose();
    await vi.waitFor(() => expect(hoisted.electronAppMock.quit).toHaveBeenCalledTimes(1));
    const thirdEvent = dispatchBeforeQuit();

    expect(thirdEvent.preventDefault).not.toHaveBeenCalled();
    expect(hoisted.hostEventBusInstances[0]?.closeAll).toHaveBeenCalledTimes(1);
    expect(hoisted.closeApplicationMock).toHaveBeenCalledTimes(1);
    expect(hoisted.electronAppMock.quit).toHaveBeenCalledTimes(1);
  });
});
