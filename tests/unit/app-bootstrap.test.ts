import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalE2EMode = process.env.MATCHACLAW_E2E;

const hoisted = vi.hoisted(() => ({
  events: [] as string[],
  onHeadersReceivedMock: vi.fn(),
  registerIpcHandlersMock: vi.fn(),
  createTrayMock: vi.fn(),
  createMenuMock: vi.fn(),
  checkForUpdatesMock: vi.fn(),
  registerUpdateHandlersMock: vi.fn(),
  loggerInitMock: vi.fn(),
  loggerInfoMock: vi.fn(),
  loggerDebugMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  loggerErrorMock: vi.fn(),
  warmupNetworkOptimizationMock: vi.fn(),
  autoInstallCliIfNeededMock: vi.fn(),
  generateCompletionCacheMock: vi.fn(),
  installCompletionToProfileMock: vi.fn(),
  applyProxySettingsMock: vi.fn(),
  applyLaunchAtStartupSettingMock: vi.fn(),
  loadHostBootstrapSettingsMock: vi.fn(),
  startHostApiServerMock: vi.fn(),
  waitForHostApiServerListeningMock: vi.fn(),
  emitHostEventMock: vi.fn(),
  registerHostEventBridgeMock: vi.fn(),
  createMainWindowMock: vi.fn(),
  loadMainWindowContentMock: vi.fn(),
  isQuittingMock: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
  },
  session: {
    defaultSession: {
      webRequest: {
        onHeadersReceived: (...args: unknown[]) => hoisted.onHeadersReceivedMock(...args),
      },
    },
  },
}));

vi.mock('../../electron/main/ipc-handlers', () => ({
  registerIpcHandlers: (...args: unknown[]) => hoisted.registerIpcHandlersMock(...args),
}));

vi.mock('../../electron/main/tray', () => ({
  createTray: (...args: unknown[]) => hoisted.createTrayMock(...args),
}));

vi.mock('../../electron/main/menu', () => ({
  createMenu: (...args: unknown[]) => hoisted.createMenuMock(...args),
}));

vi.mock('../../electron/main/updater', () => ({
  appUpdater: {
    checkForUpdates: (...args: unknown[]) => hoisted.checkForUpdatesMock(...args),
  },
  registerUpdateHandlers: (...args: unknown[]) => hoisted.registerUpdateHandlersMock(...args),
}));

vi.mock('../../electron/utils/logger', () => ({
  logger: {
    init: (...args: unknown[]) => hoisted.loggerInitMock(...args),
    info: (...args: unknown[]) => hoisted.loggerInfoMock(...args),
    debug: (...args: unknown[]) => hoisted.loggerDebugMock(...args),
    warn: (...args: unknown[]) => hoisted.loggerWarnMock(...args),
    error: (...args: unknown[]) => hoisted.loggerErrorMock(...args),
  },
}));

vi.mock('../../electron/utils/uv-env', () => ({
  warmupNetworkOptimization: (...args: unknown[]) => hoisted.warmupNetworkOptimizationMock(...args),
}));

vi.mock('../../electron/services/openclaw/openclaw-cli-service', () => ({
  autoInstallCliIfNeeded: (...args: unknown[]) => hoisted.autoInstallCliIfNeededMock(...args),
  generateCompletionCache: (...args: unknown[]) => hoisted.generateCompletionCacheMock(...args),
  installCompletionToProfile: (...args: unknown[]) => hoisted.installCompletionToProfileMock(...args),
}));

vi.mock('../../electron/main/proxy', () => ({
  applyProxySettings: (...args: unknown[]) => hoisted.applyProxySettingsMock(...args),
}));

vi.mock('../../electron/main/launch-at-startup', () => ({
  applyLaunchAtStartupSetting: (...args: unknown[]) => hoisted.applyLaunchAtStartupSettingMock(...args),
}));

vi.mock('../../electron/main/process-runtime/openclaw-gateway/config-sync', () => ({
  loadHostBootstrapSettings: (...args: unknown[]) => hoisted.loadHostBootstrapSettingsMock(...args),
}));

vi.mock('../../electron/api/server', () => ({
  startHostApiServer: (...args: unknown[]) => hoisted.startHostApiServerMock(...args),
  waitForHostApiServerListening: (...args: unknown[]) => hoisted.waitForHostApiServerListeningMock(...args),
}));

vi.mock('../../electron/main/host-event-bridge', () => ({
  emitHostEvent: (...args: unknown[]) => hoisted.emitHostEventMock(...args),
  registerHostEventBridge: (...args: unknown[]) => hoisted.registerHostEventBridgeMock(...args),
}));

vi.mock('../../electron/main/main-window', () => ({
  createMainWindow: (...args: unknown[]) => hoisted.createMainWindowMock(...args),
  loadMainWindowContent: (...args: unknown[]) => hoisted.loadMainWindowContentMock(...args),
}));

vi.mock('../../electron/main/app-state', () => ({
  isQuitting: (...args: unknown[]) => hoisted.isQuittingMock(...args),
}));

function defaultHostBootstrapSettings() {
  return {
    launchAtStartup: false,
    gatewayAutoStart: true,
    gatewayToken: 'token-test',
    proxyEnabled: false,
    proxyServer: '',
    proxyBypassRules: '',
  };
}

function createMainWindowFixture() {
  return {
    on: vi.fn(),
    hide: vi.fn(),
  };
}

function createBootstrapContext(options: {
  matchaAgentAppServerStart?: () => Promise<void>;
  runtimeHostStart?: () => Promise<void>;
} = {}) {
  const mainWindow = createMainWindowFixture();
  const hostApiServer = { close: vi.fn() };
  let currentMainWindow: unknown = null;

  hoisted.createMainWindowMock.mockReturnValue(mainWindow);
  hoisted.startHostApiServerMock.mockImplementation(() => {
    hoisted.events.push('startHostApiServer');
    return hostApiServer;
  });
  hoisted.waitForHostApiServerListeningMock.mockImplementation(async (server: unknown) => {
    hoisted.events.push('waitForHostApiServerListening');
    return server;
  });

  const runtimeHostManager = {
    start: vi.fn(options.runtimeHostStart ?? (async () => {
      hoisted.events.push('runtimeHostManager.start:begin');
      await Promise.resolve();
      hoisted.events.push('runtimeHostManager.start:end');
    })),
    request: vi.fn(async () => {
      hoisted.events.push('runtimeHostManager.request');
      return { data: { job: { id: 'runtime-host-job-1' } } };
    }),
  };
  const gatewayManager = {
    start: vi.fn(async () => {
      hoisted.events.push('gatewayManager.start');
    }),
  };
  const matchaAgentAppServerManager = {
    start: vi.fn(options.matchaAgentAppServerStart ?? (async () => {
      hoisted.events.push('matchaAgentAppServerManager.start');
    })),
  };
  const setMainWindow = vi.fn((window: unknown) => {
    currentMainWindow = window;
  });
  const getMainWindow = vi.fn(() => currentMainWindow);

  return {
    deps: {
      gatewayManager,
      matchaAgentAppServerManager,
      runtimeHostManager,
      hostEventBus: {},
      setMainWindow,
      getMainWindow,
    },
    mainWindow,
    hostApiServer,
    gatewayManager,
    matchaAgentAppServerManager,
    runtimeHostManager,
  };
}

async function importBootstrapMainApplication() {
  const module = await import('../../electron/main/app-bootstrap');
  return module.bootstrapMainApplication;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  hoisted.events.length = 0;
  delete process.env.MATCHACLAW_E2E;

  hoisted.warmupNetworkOptimizationMock.mockResolvedValue(undefined);
  hoisted.autoInstallCliIfNeededMock.mockResolvedValue(undefined);
  hoisted.applyProxySettingsMock.mockImplementation(async () => {
    hoisted.events.push('applyProxySettings');
  });
  hoisted.applyLaunchAtStartupSettingMock.mockImplementation(async () => {
    hoisted.events.push('applyLaunchAtStartupSetting');
  });
  hoisted.loadHostBootstrapSettingsMock.mockImplementation(async () => {
    hoisted.events.push('loadHostBootstrapSettings');
    return defaultHostBootstrapSettings();
  });
  hoisted.loadMainWindowContentMock.mockImplementation(() => {
    hoisted.events.push('loadMainWindowContent');
  });
  hoisted.isQuittingMock.mockReturnValue(false);
});

afterEach(() => {
  if (originalE2EMode === undefined) {
    delete process.env.MATCHACLAW_E2E;
  } else {
    process.env.MATCHACLAW_E2E = originalE2EMode;
  }
});

describe('bootstrapMainApplication', () => {
  it('先启动 runtime host，再读取 host bootstrap settings 并执行不含 provider bootstrap 的 gateway auto-start', async () => {
    const bootstrapMainApplication = await importBootstrapMainApplication();
    const context = createBootstrapContext();

    await bootstrapMainApplication(context.deps as never);

    expect(context.runtimeHostManager.start).toHaveBeenCalledTimes(1);
    expect(hoisted.loadHostBootstrapSettingsMock).toHaveBeenCalledTimes(1);
    expect(hoisted.applyLaunchAtStartupSettingMock).toHaveBeenCalledWith(false);
    expect(context.gatewayManager.start).toHaveBeenCalledTimes(1);
    expect(context.runtimeHostManager.request).not.toHaveBeenCalled();
    expect(hoisted.startHostApiServerMock).toHaveBeenCalledWith(expect.objectContaining({
      matchaAgentAppServerManager: context.matchaAgentAppServerManager,
    }));

    expect(hoisted.events.indexOf('runtimeHostManager.start:end')).toBeLessThan(
      hoisted.events.indexOf('loadHostBootstrapSettings'),
    );
    expect(hoisted.events.indexOf('runtimeHostManager.start:end')).toBeLessThan(
      hoisted.events.indexOf('gatewayManager.start'),
    );
  });

  it('gatewayAutoStart=false 时不发送 provider bootstrap request 或启动 gateway', async () => {
    hoisted.loadHostBootstrapSettingsMock.mockImplementation(async () => {
      hoisted.events.push('loadHostBootstrapSettings');
      return {
        ...defaultHostBootstrapSettings(),
        launchAtStartup: true,
        gatewayAutoStart: false,
      };
    });
    const bootstrapMainApplication = await importBootstrapMainApplication();
    const context = createBootstrapContext();

    await bootstrapMainApplication(context.deps as never);

    expect(context.runtimeHostManager.start).toHaveBeenCalledTimes(1);
    expect(hoisted.applyLaunchAtStartupSettingMock).toHaveBeenCalledWith(true);
    expect(context.runtimeHostManager.request).not.toHaveBeenCalled();
    expect(context.gatewayManager.start).not.toHaveBeenCalled();
  });

  it('E2E 模式不启动 gateway 或发送 provider bootstrap request', async () => {
    process.env.MATCHACLAW_E2E = '1';
    const bootstrapMainApplication = await importBootstrapMainApplication();
    const context = createBootstrapContext();

    await bootstrapMainApplication(context.deps as never);

    expect(context.runtimeHostManager.start).toHaveBeenCalledTimes(1);
    expect(context.gatewayManager.start).not.toHaveBeenCalled();
    expect(context.runtimeHostManager.request).not.toHaveBeenCalled();
  });

  it('matcha-agent app-server resource missing 不会中断主应用 bootstrap', async () => {
    const bootstrapMainApplication = await importBootstrapMainApplication();
    const context = createBootstrapContext({
      matchaAgentAppServerStart: async () => {
        hoisted.events.push('matchaAgentAppServerManager.start');
        throw new Error('app-server resource missing: app-server entrypoint not found');
      },
    });

    await expect(bootstrapMainApplication(context.deps as never)).resolves.toEqual({
      mainWindow: context.mainWindow,
      hostApiServer: context.hostApiServer,
    });
    expect(context.matchaAgentAppServerManager.start).toHaveBeenCalledTimes(1);
    expect(context.runtimeHostManager.start).toHaveBeenCalledTimes(1);
    expect(hoisted.startHostApiServerMock).toHaveBeenCalledTimes(1);
    expect(hoisted.loadMainWindowContentMock).toHaveBeenCalledWith(context.mainWindow);
  });
});
