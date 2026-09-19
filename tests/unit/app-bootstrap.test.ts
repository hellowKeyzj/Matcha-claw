import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalE2EMode = process.env.MATCHACLAW_E2E;
const e2eStartupOutcomeKey = '__matchaclawE2EStartupOutcome';

type E2EProcess = typeof process & {
  [e2eStartupOutcomeKey]?: unknown;
  __matchaclawE2ECronProviderTrace?: readonly string[];
};

function readE2EStartupOutcome(): unknown {
  return (process as E2EProcess)[e2eStartupOutcomeKey];
}

function readE2ECronProviderTrace(): readonly string[] | undefined {
  return (process as E2EProcess).__matchaclawE2ECronProviderTrace;
}

function clearE2EProcessState(): void {
  delete (process as E2EProcess)[e2eStartupOutcomeKey];
  delete (process as E2EProcess).__matchaclawE2ECronProviderTrace;
}

const hoisted = vi.hoisted(() => ({
  onHeadersReceivedMock: vi.fn(),
  registerStaticIpcHandlersMock: vi.fn(),
  registerRuntimeIpcHandlersMock: vi.fn(),
  createTrayMock: vi.fn(),
  createMenuMock: vi.fn(),
  checkForUpdatesMock: vi.fn(),
  registerUpdateHandlersMock: vi.fn(),
  registerE2EUpdateHandlersMock: vi.fn(),
  loggerInitMock: vi.fn(),
  loggerInfoMock: vi.fn(),
  loggerDebugMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  applyLaunchAtStartupSettingMock: vi.fn(),
  warmupNetworkOptimizationMock: vi.fn(),
  registerHostEventBridgeMock: vi.fn(),
  createMainWindowMock: vi.fn(),
  loadMainWindowContentMock: vi.fn(),
  isQuittingMock: vi.fn(),
  createRuntimeHostDeliveryMock: vi.fn(),
  createRuntimeHostTransportBundleMock: vi.fn(),
  createDiagnosticsExportDependenciesMock: vi.fn(),
  createCloudAccountClientMock: vi.fn(),
  createCloudAccountServiceMock: vi.fn(),
  createCloudProviderSyncMock: vi.fn(),
  cloudAccountServicePrewarmMock: vi.fn(),
  startHostApiServerMock: vi.fn(),
  waitForHostApiServerListeningMock: vi.fn(),
  createProviderCredentialStatusTransportMock: vi.fn(),
  waitForGatewayControlReadyMock: vi.fn(),
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
  registerRuntimeIpcHandlers: (...args: unknown[]) => hoisted.registerRuntimeIpcHandlersMock(...args),
  registerStaticIpcHandlers: (...args: unknown[]) => hoisted.registerStaticIpcHandlersMock(...args),
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
  registerE2EUpdateHandlers: (...args: unknown[]) => hoisted.registerE2EUpdateHandlersMock(...args),
  registerUpdateHandlers: (...args: unknown[]) => hoisted.registerUpdateHandlersMock(...args),
}));
vi.mock('../../electron/utils/logger', () => ({
  logger: {
    init: (...args: unknown[]) => hoisted.loggerInitMock(...args),
    info: (...args: unknown[]) => hoisted.loggerInfoMock(...args),
    debug: (...args: unknown[]) => hoisted.loggerDebugMock(...args),
    warn: (...args: unknown[]) => hoisted.loggerWarnMock(...args),
    error: (...args: unknown[]) => hoisted.loggerWarnMock(...args),
  },
}));
vi.mock('../../electron/utils/uv-env', () => ({
  warmupNetworkOptimization: (...args: unknown[]) => hoisted.warmupNetworkOptimizationMock(...args),
}));
vi.mock('../../electron/main/host-event-bridge', () => ({
  registerHostEventBridge: (...args: unknown[]) => hoisted.registerHostEventBridgeMock(...args),
}));
vi.mock('../../electron/api/server', () => ({
  startHostApiServer: (...args: unknown[]) => hoisted.startHostApiServerMock(...args),
  waitForHostApiServerListening: (...args: unknown[]) =>
    hoisted.waitForHostApiServerListeningMock(...args),
}));
vi.mock('../../electron/main/main-window', () => ({
  createMainWindow: (...args: unknown[]) => hoisted.createMainWindowMock(...args),
  loadMainWindowContent: (...args: unknown[]) => hoisted.loadMainWindowContentMock(...args),
}));
vi.mock('../../electron/main/app-state', () => ({
  isQuitting: (...args: unknown[]) => hoisted.isQuittingMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/delivery', () => ({
  createRuntimeHostDelivery: (...args: unknown[]) => hoisted.createRuntimeHostDeliveryMock(...args),
}));
vi.mock('../../electron/main/runtime-host-delivery/transport/bundle', () => ({
  createRuntimeHostTransportBundle: (...args: unknown[]) =>
    hoisted.createRuntimeHostTransportBundleMock(...args),
}));
vi.mock('../../electron/main/ipc/diagnostics-export-ipc', () => ({
  createDiagnosticsExportDependencies: (...args: unknown[]) =>
    hoisted.createDiagnosticsExportDependenciesMock(...args),
}));
vi.mock('../../electron/main/cloud-account/client', () => ({
  createCloudAccountClient: (...args: unknown[]) => hoisted.createCloudAccountClientMock(...args),
}));
vi.mock('../../electron/main/cloud-account/service', () => ({
  createCloudAccountService: (...args: unknown[]) => hoisted.createCloudAccountServiceMock(...args),
}));
vi.mock('../../electron/main/cloud-account/provider-sync', () => ({
  createCloudProviderSync: (...args: unknown[]) => hoisted.createCloudProviderSyncMock(...args),
}));
vi.mock('../../electron/main/launch-at-startup', () => ({
  applyLaunchAtStartupSetting: (...args: unknown[]) =>
    hoisted.applyLaunchAtStartupSettingMock(...args),
}));
vi.mock('../../electron/main/ipc/provider-private-auth', () => ({
  createProviderCredentialStatusTransport: (...args: unknown[]) =>
    hoisted.createProviderCredentialStatusTransportMock(...args),
}));
vi.mock('../../electron/main/gateway-control-ready-probe', () => ({
  GatewayControlReadinessBudgetError: class GatewayControlReadinessBudgetError extends Error {},
  waitForGatewayControlReady: (...args: unknown[]) =>
    hoisted.waitForGatewayControlReadyMock(...args),
}));

function createMainWindowFixture() {
  return {
    on: vi.fn(),
    hide: vi.fn(),
    show: vi.fn(),
    isDestroyed: vi.fn(() => false),
  };
}

function createDirectRuntimeHostFixture() {
  return {
    pid: 10_001,
    command: vi.fn(),
    onSafeEvent: vi.fn(() => () => {}),
    onExit: vi.fn(() => () => {}),
    readE2ECronProviderTrace: vi.fn(() => ['cron-before']),
    stop: vi.fn().mockResolvedValue(undefined),
    forceKill: vi.fn().mockResolvedValue(undefined),
  };
}

function createRuntimeHostTransportBundleFixture() {
  const sessionEventsTransport = {
    onDelta: vi.fn(),
    close: vi.fn(),
  };
  const hostApiTransports = {
    sessionListTransport: { list: vi.fn() },
    runtimeDirectoryTransport: { list: vi.fn() },
    fleetTransport: { execute: vi.fn() },
    sessionContentTransport: { load: vi.fn() },
    sessionTimelineTransport: { list: vi.fn() },
    matchaSessionListTransport: { list: vi.fn() },
    diagnosticsArchiveTransport: { archive: vi.fn(), download: vi.fn() },
    workspaceTextTransport: { read: vi.fn() },
    workspaceBinaryTransport: { read: vi.fn() },
    workspaceDirectoryTransport: { list: vi.fn() },
    workspaceWriteTransport: { write: vi.fn() },
    workspaceMediaTransport: { thumbnail: vi.fn() },
    sessionAbortTransport: { abort: vi.fn() },
    sessionCreateTransport: { create: vi.fn() },
    sessionDeleteTransport: { delete: vi.fn() },
    sessionRenameTransport: { rename: vi.fn() },
    sessionApprovalTransport: { list: vi.fn(), respond: vi.fn() },
    sessionSendTransport: { send: vi.fn() },
    sessionModelSelectionTransport: { patch: vi.fn() },
    sessionPermissionTransport: { get: vi.fn(), set: vi.fn() },
    securityEmergencyTransport: { run: vi.fn() },
    channelStatusTransport: { read: vi.fn() },
    channelCatalogTransport: { read: vi.fn() },
    channelAuthorizationTransport: { authorize: vi.fn() },
    channelConfigReadTransport: { read: vi.fn() },
    channelCredentialsTransport: { validate: vi.fn() },
    channelDeleteConfigTransport: { deleteConfig: vi.fn() },
    channelLoginTransport: { login: vi.fn() },
    channelControlTransport: { operate: vi.fn() },
    channelPairingTransport: { list: vi.fn(), approve: vi.fn() },
    settingsDesiredTransport: {
      read: vi.fn().mockResolvedValue({
        browserMode: 'relay',
        launchAtStartup: false,
        gatewayAutoStart: true,
        proxyEnabled: false,
        proxyServer: '',
        proxyBypassRules: '',
      }),
      submit: vi.fn(),
    },
    securityPolicyTransport: {
      operate: vi.fn(),
      read: vi.fn(),
      readAudit: vi.fn(),
      submit: vi.fn(),
    },
    securityRuleCatalogTransport: { read: vi.fn() },
    cronTransport: { execute: vi.fn() },
    taskManagerTransport: { list: vi.fn() },
    agentsTransport: { execute: vi.fn() },
    teamPublicTransport: { read: vi.fn() },
    teamTaskBoardTransport: { read: vi.fn() },
    teamRoleSessionsTransport: { read: vi.fn() },
    teamApprovalsTransport: { read: vi.fn() },
    teamGraphTransport: { read: vi.fn() },
    teamSkillTransport: { execute: vi.fn() },
    teamTriggerTransport: { execute: vi.fn() },
    teamWebhookAuthTransport: { read: vi.fn() },
    teamLifecycleTransport: {
      list: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
      resume: vi.fn(),
      cancel: vi.fn(),
    },
    manualTeamTransport: { materializeAndCreate: vi.fn() },
    teamHumanDecisionTransport: { resolve: vi.fn() },
    providerAccountsTransport: { execute: vi.fn() },
    providerModelsTransport: { execute: vi.fn() },
    externalConnectorsTransport: { execute: vi.fn() },
    openClawMcpServersTransport: { execute: vi.fn() },
    providerRoutingTransport: { execute: vi.fn() },
    clawHubSkillInstallTransport: { install: vi.fn() },
    clawHubSkillSearchTransport: { search: vi.fn() },
    skillBundleTransport: { exportBundles: vi.fn(), importBundles: vi.fn() },
    skillsManagementTransport: { execute: vi.fn() },
    sealedSkillsTransport: { execute: vi.fn() },
    pluginsTransport: { execute: vi.fn() },
    usageTransport: { read: vi.fn() },
    matchaAgentHistoryTransport: { history: vi.fn() },
  };
  return {
    hostApiTransports,
    sessionEventsTransport,
    close: vi.fn(() => sessionEventsTransport.close()),
  };
}

type RuntimeHostTransportBundleFixture = ReturnType<typeof createRuntimeHostTransportBundleFixture>;

function readCreatedTransportBundle(): RuntimeHostTransportBundleFixture {
  const bundle = hoisted.createRuntimeHostTransportBundleMock.mock.results[0]?.value;
  if (!bundle) throw new Error('transport bundle was not created');
  return bundle as RuntimeHostTransportBundleFixture;
}

function createBootstrapContext() {
  const mainWindow = createMainWindowFixture();
  const directRuntimeHost = createDirectRuntimeHostFixture();
  const closeRuntimeHostDelivery = vi.fn().mockResolvedValue(undefined);
  const launchRuntimeHost = vi.fn().mockResolvedValue(directRuntimeHost);
  const deliveryIssuer = { verificationKey: 'public-key', signDecision: vi.fn(() => 'signed') };
  let currentMainWindow: unknown = null;
  const setMainWindow = vi.fn((window: unknown) => {
    currentMainWindow = window;
  });
  const getMainWindow = vi.fn(() => currentMainWindow);
  hoisted.createRuntimeHostDeliveryMock.mockResolvedValue({
    issuer: deliveryIssuer,
    launchRuntimeHost,
    close: closeRuntimeHostDelivery,
    runtimeHostTransportPort: 34_101,
  });
  return {
    deps: {
      hostEventBus: { emit: vi.fn(), on: vi.fn(() => () => undefined) },
      setMainWindow,
      getMainWindow,
    },
    deliveryIssuer,
    closeRuntimeHostDelivery,
    launchRuntimeHost,
    directRuntimeHost,
    mainWindow,
  };
}

async function importBootstrapMainApplication() {
  const module = await import('../../electron/main/app-bootstrap');
  return module.bootstrapMainApplication;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  clearE2EProcessState();
  delete process.env.MATCHACLAW_E2E;
  hoisted.createMainWindowMock.mockReturnValue(createMainWindowFixture());
  hoisted.warmupNetworkOptimizationMock.mockResolvedValue(undefined);
  hoisted.applyLaunchAtStartupSettingMock.mockResolvedValue(true);
  hoisted.isQuittingMock.mockReturnValue(false);
  hoisted.createRuntimeHostTransportBundleMock.mockImplementation(() =>
    createRuntimeHostTransportBundleFixture()
  );
  hoisted.createCloudProviderSyncMock.mockReturnValue({ reconcile: vi.fn() });
  hoisted.createCloudAccountServiceMock.mockReturnValue({
    prewarm: hoisted.cloudAccountServicePrewarmMock,
  });
  hoisted.createCloudAccountClientMock.mockReturnValue({ fetchClientBootstrap: vi.fn() });
  hoisted.createDiagnosticsExportDependenciesMock.mockReturnValue({
    transport: { download: vi.fn() },
    showSaveDialog: vi.fn(),
    writeFile: vi.fn(),
    getE2ESavePath: vi.fn(),
  });
  hoisted.createProviderCredentialStatusTransportMock.mockReturnValue({ hasApiKey: vi.fn() });
  hoisted.waitForGatewayControlReadyMock.mockResolvedValue(undefined);
  hoisted.startHostApiServerMock.mockReturnValue({});
  hoisted.waitForHostApiServerListeningMock.mockResolvedValue({});
});

afterEach(() => {
  clearE2EProcessState();
  if (originalE2EMode === undefined) {
    delete process.env.MATCHACLAW_E2E;
  } else {
    process.env.MATCHACLAW_E2E = originalE2EMode;
  }
});

describe('bootstrapMainApplication', () => {
  it('直接启动 Rust Host，并将同一 transport bundle 交给 Host API、IPC 与事件桥', async () => {
    const bootstrapMainApplication = await importBootstrapMainApplication();
    const context = createBootstrapContext();
    hoisted.createMainWindowMock.mockReturnValue(context.mainWindow);
    context.launchRuntimeHost.mockResolvedValue(context.directRuntimeHost);

    const result = await bootstrapMainApplication(context.deps as never);
    const bundle = readCreatedTransportBundle();

    expect(hoisted.createRuntimeHostDeliveryMock).toHaveBeenCalledWith(context.deps.hostEventBus);
    expect(hoisted.createRuntimeHostTransportBundleMock).toHaveBeenCalledWith({
      issuer: context.deliveryIssuer,
      runtimeHostTransportPort: 34_101,
      reportE2ECronTrace: undefined,
    });
    expect(hoisted.waitForGatewayControlReadyMock).not.toHaveBeenCalled();
    expect(hoisted.createCloudAccountClientMock).toHaveBeenCalledOnce();
    expect(hoisted.createCloudProviderSyncMock).toHaveBeenCalledWith({
      fetchClientBootstrap: expect.any(Function),
      providerAccountsTransport: bundle.hostApiTransports.providerAccountsTransport,
      providerModelsTransport: bundle.hostApiTransports.providerModelsTransport,
    });
    expect(hoisted.createCloudAccountServiceMock).toHaveBeenCalledWith(
      hoisted.createCloudAccountClientMock.mock.results[0]?.value,
      hoisted.createCloudProviderSyncMock.mock.results[0]?.value,
    );
    expect(hoisted.cloudAccountServicePrewarmMock).toHaveBeenCalledOnce();

    const hostApiContext = hoisted.startHostApiServerMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(hostApiContext.runtimeHostTransports).toBe(bundle.hostApiTransports);
    for (const key of Object.keys(bundle.hostApiTransports)) {
      expect(hostApiContext).not.toHaveProperty(key);
    }
    expect(hostApiContext).toEqual(expect.objectContaining({
      cloudAccountService: expect.objectContaining({ prewarm: expect.any(Function) }),
      eventBus: context.deps.hostEventBus,
      runtimeHost: expect.objectContaining({
        command: expect.any(Function),
        restart: expect.any(Function),
      }),
      rendererEventRoutes: expect.anything(),
      providerCredentialStatusTransport:
        hoisted.createProviderCredentialStatusTransportMock.mock.results[0]?.value,
    }));
    expect(hostApiContext).not.toHaveProperty('hostApiTransports');
    expect(hostApiContext).not.toHaveProperty('sessionEventsTransport');
    expect(hostApiContext).not.toHaveProperty('close');
    expect(hostApiContext).not.toHaveProperty('licenseService');
    expect(hoisted.startHostApiServerMock).toHaveBeenCalledWith(
      hostApiContext,
      undefined,
      34_101,
    );
    expect(hoisted.waitForHostApiServerListeningMock).toHaveBeenCalledWith({});
    expect(hoisted.registerRuntimeIpcHandlersMock).toHaveBeenCalledWith(
      expect.objectContaining({ command: expect.any(Function) }),
      context.deps.getMainWindow,
      bundle.hostApiTransports.providerAccountsTransport,
      expect.objectContaining({ transport: expect.objectContaining({ download: expect.any(Function) }) }),
    );
    expect(hoisted.createDiagnosticsExportDependenciesMock).toHaveBeenCalledWith(
      bundle.hostApiTransports.diagnosticsArchiveTransport,
    );
    expect(hoisted.registerHostEventBridgeMock).toHaveBeenCalledWith({
      runtimeHost: expect.objectContaining({
        command: expect.any(Function),
        onRestart: expect.any(Function),
      }),
      hostEventBus: context.deps.hostEventBus,
      getMainWindow: context.deps.getMainWindow,
      rendererEventRoutes: expect.anything(),
      sessionEvents: bundle.sessionEventsTransport,
    });
    expect(result).toEqual(expect.objectContaining({
      mainWindow: context.mainWindow,
      directRuntimeHost: expect.objectContaining({
        command: expect.any(Function),
        restart: expect.any(Function),
      }),
    }));
    expect(hoisted.loadMainWindowContentMock).toHaveBeenCalledWith(context.mainWindow);
    expect(readE2EStartupOutcome()).toBeUndefined();

    await result.closeRuntimeHostDelivery();
    expect(bundle.close).toHaveBeenCalledOnce();
    expect(bundle.sessionEventsTransport.close).toHaveBeenCalledOnce();
    expect(context.closeRuntimeHostDelivery).toHaveBeenCalledOnce();
    expect(bundle.close.mock.invocationCallOrder[0]).toBeLessThan(
      context.closeRuntimeHostDelivery.mock.invocationCallOrder[0],
    );
  });

  it('loads renderer after static IPC registration and before Runtime Host readiness', async () => {
    process.env.MATCHACLAW_E2E = '1';
    const bootstrapMainApplication = await importBootstrapMainApplication();
    const context = createBootstrapContext();
    let resolveRuntimeHost!: (runtimeHost: ReturnType<typeof createDirectRuntimeHostFixture>) => void;
    hoisted.createMainWindowMock.mockReturnValue(context.mainWindow);
    context.launchRuntimeHost.mockReturnValue(new Promise((resolve) => {
      resolveRuntimeHost = resolve;
    }));

    const bootstrapping = bootstrapMainApplication(context.deps as never);
    await Promise.resolve();

    expect(hoisted.registerStaticIpcHandlersMock).toHaveBeenCalledWith(context.deps.getMainWindow);
    expect(hoisted.registerE2EUpdateHandlersMock).toHaveBeenCalledOnce();
    expect(hoisted.loadMainWindowContentMock).toHaveBeenCalledWith(context.mainWindow);
    expect(hoisted.createRuntimeHostTransportBundleMock).not.toHaveBeenCalled();
    expect(hoisted.startHostApiServerMock).not.toHaveBeenCalled();
    expect(hoisted.registerRuntimeIpcHandlersMock).not.toHaveBeenCalled();
    expect(context.mainWindow.show).not.toHaveBeenCalled();

    resolveRuntimeHost(context.directRuntimeHost);
    await expect(bootstrapping).resolves.toMatchObject({
      directRuntimeHost: expect.objectContaining({
        command: expect.any(Function),
        restart: expect.any(Function),
      }),
    });
    expect(context.deps.hostEventBus.on).toHaveBeenCalledWith('gateway:status', expect.any(Function));
    const reveal = (context.deps.hostEventBus.on as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as (payload: unknown) => void;
    reveal({ processState: 'stopped' });
    expect(context.mainWindow.show).not.toHaveBeenCalled();
    reveal({ processState: 'starting' });
    expect(context.mainWindow.show).toHaveBeenCalledOnce();
  });

  it('does not block Host admission on OpenClaw peer readiness', async () => {
    const bootstrapMainApplication = await importBootstrapMainApplication();
    const context = createBootstrapContext();
    hoisted.createMainWindowMock.mockReturnValue(context.mainWindow);
    context.launchRuntimeHost.mockResolvedValue(context.directRuntimeHost);

    await expect(bootstrapMainApplication(context.deps as never)).resolves.toMatchObject({
      directRuntimeHost: expect.objectContaining({
        command: expect.any(Function),
        restart: expect.any(Function),
      }),
    });

    expect(hoisted.waitForGatewayControlReadyMock).not.toHaveBeenCalled();
    expect(context.directRuntimeHost.stop).not.toHaveBeenCalled();
    expect(hoisted.createRuntimeHostTransportBundleMock).toHaveBeenCalledOnce();
  });

  it('后续 bootstrap 失败时停止已启动的 Rust Host 并先关闭 SSE bundle', async () => {
    const bootstrapMainApplication = await importBootstrapMainApplication();
    const context = createBootstrapContext();
    const failure = new Error('Host API listen failed');
    hoisted.createMainWindowMock.mockReturnValue(context.mainWindow);
    context.launchRuntimeHost.mockResolvedValue(context.directRuntimeHost);
    hoisted.waitForHostApiServerListeningMock.mockRejectedValue(failure);

    await expect(bootstrapMainApplication(context.deps as never)).rejects.toBe(failure);
    const bundle = readCreatedTransportBundle();

    expect(context.directRuntimeHost.stop).toHaveBeenCalledOnce();
    expect(context.directRuntimeHost.forceKill).not.toHaveBeenCalled();
    expect(bundle.close).toHaveBeenCalledOnce();
    expect(bundle.sessionEventsTransport.close).toHaveBeenCalledOnce();
    expect(context.closeRuntimeHostDelivery).toHaveBeenCalledOnce();
    expect(bundle.close.mock.invocationCallOrder[0]).toBeLessThan(
      context.closeRuntimeHostDelivery.mock.invocationCallOrder[0],
    );
  });

  it('停止失败时强制终止已启动的 Rust Host', async () => {
    const bootstrapMainApplication = await importBootstrapMainApplication();
    const context = createBootstrapContext();
    hoisted.createMainWindowMock.mockReturnValue(context.mainWindow);
    context.launchRuntimeHost.mockResolvedValue(context.directRuntimeHost);
    hoisted.waitForHostApiServerListeningMock.mockRejectedValue(
      new Error('Host API listen failed')
    );
    context.directRuntimeHost.stop.mockRejectedValue(new Error('graceful stop failed'));

    await expect(bootstrapMainApplication(context.deps as never)).rejects.toThrow(
      'Host API listen failed'
    );

    expect(context.directRuntimeHost.stop).toHaveBeenCalledOnce();
    expect(context.directRuntimeHost.forceKill).toHaveBeenCalledOnce();
  });

  it('停止超时后强制终止已启动的 Rust Host', async () => {
    vi.useFakeTimers();
    try {
      const bootstrapMainApplication = await importBootstrapMainApplication();
      const context = createBootstrapContext();
      hoisted.createMainWindowMock.mockReturnValue(context.mainWindow);
      context.launchRuntimeHost.mockResolvedValue(context.directRuntimeHost);
      hoisted.waitForHostApiServerListeningMock.mockRejectedValue(
        new Error('Host API listen failed')
      );
      context.directRuntimeHost.stop.mockReturnValue(new Promise(() => undefined));

      const outcome = bootstrapMainApplication(context.deps as never).then(
        () => undefined,
        (error) => error
      );
      await vi.advanceTimersByTimeAsync(5000);

      const error = await outcome;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('Host API listen failed');
      expect(context.directRuntimeHost.forceKill).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('不启动旧 peer runtime 或旧 Node Host API server', async () => {
    const bootstrapMainApplication = await importBootstrapMainApplication();
    const context = createBootstrapContext();
    hoisted.createMainWindowMock.mockReturnValue(context.mainWindow);
    context.launchRuntimeHost.mockResolvedValue(context.directRuntimeHost);

    await bootstrapMainApplication(context.deps as never);

    expect(context.launchRuntimeHost).toHaveBeenCalledTimes(1);
    expect(hoisted.registerRuntimeIpcHandlersMock.mock.calls[0]).toHaveLength(4);
  });

  it('E2E 模式仍通过同一 Rust Host 路径启动，并只在 bundle 注入 Cron trace callback', async () => {
    process.env.MATCHACLAW_E2E = '1';
    const bootstrapMainApplication = await importBootstrapMainApplication();
    const context = createBootstrapContext();
    hoisted.createMainWindowMock.mockReturnValue(context.mainWindow);
    context.launchRuntimeHost.mockResolvedValue(context.directRuntimeHost);

    await bootstrapMainApplication(context.deps as never);

    expect(context.launchRuntimeHost).toHaveBeenCalledTimes(1);
    expect(hoisted.createTrayMock).not.toHaveBeenCalled();
    expect(hoisted.registerUpdateHandlersMock).not.toHaveBeenCalled();
    expect(hoisted.registerE2EUpdateHandlersMock).toHaveBeenCalledOnce();
    expect(readE2EStartupOutcome()).toEqual({ stage: 'ready', outcome: 'started' });

    const bundleInput = hoisted.createRuntimeHostTransportBundleMock.mock.calls[0]?.[0] as {
      reportE2ECronTrace?: (stage: string) => Promise<void>;
    };
    expect(bundleInput.reportE2ECronTrace).toEqual(expect.any(Function));
    await bundleInput.reportE2ECronTrace?.('cron-ready');
    expect(readE2ECronProviderTrace()).toEqual(['cron-before', 'cron-ready']);
  });

  it('E2E 保留 delivery bootstrap 已发布的安全失败分类', async () => {
    process.env.MATCHACLAW_E2E = '1';
    const failure = new Error('E:\\private\\runtime-host.json contains token');
    const bootstrapMainApplication = await importBootstrapMainApplication();
    const context = createBootstrapContext();
    hoisted.createRuntimeHostDeliveryMock.mockImplementation(async () => {
      Object.defineProperty(process as E2EProcess, e2eStartupOutcomeKey, {
        configurable: true,
        enumerable: false,
        value: Object.freeze({ stage: 'bootstrap-resolve', outcome: 'BOOTSTRAP_RESOLVE_FAILED' }),
        writable: false,
      });
      throw failure;
    });

    await expect(bootstrapMainApplication(context.deps as never)).rejects.toBe(failure);

    expect(hoisted.createRuntimeHostTransportBundleMock).not.toHaveBeenCalled();
    expect(readE2EStartupOutcome()).toEqual({
      stage: 'bootstrap-resolve',
      outcome: 'BOOTSTRAP_RESOLVE_FAILED',
    });
    expect(JSON.stringify(readE2EStartupOutcome())).not.toContain('private');
    expect(JSON.stringify(readE2EStartupOutcome())).not.toContain('token');
  });

  it('E2E 保留 DirectRuntimeHost delivery 的安全失败分类', async () => {
    process.env.MATCHACLAW_E2E = '1';
    const bootstrapMainApplication = await importBootstrapMainApplication();
    const context = createBootstrapContext();
    const failure = Object.assign(new Error('C:\\private\\runtime-host.exe'), {
      code: 'SPAWN_FAILED',
      name: 'DirectRuntimeHostDeliveryError',
    });
    context.launchRuntimeHost.mockRejectedValue(failure);

    await expect(bootstrapMainApplication(context.deps as never)).rejects.toBe(failure);

    expect(hoisted.createRuntimeHostTransportBundleMock).not.toHaveBeenCalled();
    expect(readE2EStartupOutcome()).toEqual({
      stage: 'runtime-host-launch',
      outcome: 'SPAWN_FAILED',
    });
    expect(JSON.stringify(readE2EStartupOutcome())).not.toContain('private');
  });
});
