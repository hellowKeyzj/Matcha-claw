import { app, session, type BrowserWindow } from 'electron';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { ApplicationPluginOwner } from './app-plugins/owner';
import { AppPluginPackageWorker } from './app-plugins/package-client';
import { AppPluginHost, type AppPluginHostOptions } from './app-plugins/host';
import { createAppPluginExecution } from './app-plugins/execution';
import { createAppPluginServices } from './app-plugins/services';
import { registerAppPluginExecutionTargets } from '../api/ipc/app-plugin-execution-targets';
import { collectPluginVideo, generatePluginAudio, generatePluginMedia, generatePluginText, listPluginMediaModels, queryPluginVideo, submitPluginVideo } from './app-plugins/media';
import { startAppPluginAgentGateway } from './app-plugins/agent-gateway';
import type { RuntimeHostApiDependencies } from '../api/context';
import { createHostApiDispatcher } from '../api/dispatcher';
import {
  registerRuntimeIpcHandlers,
  registerStaticIpcHandlers,
} from '../api/ipc/register';
import { createTray } from './desktop/tray';
import { createMenu } from './desktop/menu';
import { appUpdater } from './updates/updater';
import { registerE2EUpdateHandlers, registerUpdateHandlers } from '../api/ipc/update-ipc';
import { logger } from '../utils/logger';
import { warmupNetworkOptimization } from './network/optimization';
import type { HostEventBus } from '../api/event-bus';
import { startHostApiServer, waitForHostApiServerListening } from '../api/server';
import { registerHostEventBridge, registerMainEventBridge } from '../api/events/host-event-bridge';
import { RendererSessionObservationRegistry } from './sessions/observations';
import { RuntimeStatusProjection } from './runtime-host-delivery/status';
import { observationRequest } from './runtime-host-delivery/transport/sessions/observation';
import { createMainWindow, loadMainWindowContent } from './desktop/main-window';
import { isQuitting } from './lifecycle/state';
import { applyLaunchAtStartupSetting } from './settings/launch-at-startup';
import {
  type DirectRuntimeHost,
  type DirectRuntimeHostDeliveryError,
  type DirectRuntimeHostDeliveryErrorCode,
} from './runtime-host-delivery/direct-host';
import { createRuntimeHostDelivery, type RuntimeHostDelivery } from './composition/runtime';
import { RuntimeHostLifecycleOwner } from './runtime-host-delivery/lifecycle-owner';
import { createCloudAccountClient } from './cloud-account/client';
import { createCloudAccountService, type CloudAccountRuntime } from './cloud-account/service';
import { createCloudProviderSync } from './cloud-account/provider-sync';
import { createProviderCallObserver } from './providers/call-observation';
import { createCallSubscriber } from '../api/events/call-observation';
import { createDiagnosticsExportDependencies } from '../api/ipc/diagnostics-export-ipc';
import {
  createRuntimeHostTransportBundle,
  type RuntimeHostTransportBundle,
} from './composition/transports';
import {
  createProviderCredentialStatusTransport,
  createProviderPrivateAuth,
  type ProviderPrivateAuthDependencies,
} from './providers/private-auth';
import { registerProviderPrivateAuthHandlers } from '../api/ipc/provider-private-auth';
import { createFleetCredentialWriteAdapter } from './fleet/credentials';
import { registerWorldPrivateHandlers } from '../api/ipc/world-private';
import { createWorldPrivateOperations } from './world/private-operations';
import { createChannelAuthorization } from './channels/authorization';
import { composeLicenseService } from './license/composition';
import { createIab } from './iab/composition';
import { createAccess } from './access';
import { getRuntimeHostStateDir } from '../utils/paths';
import { createNetworkAccess } from './network-access';
import { createInterconnect } from './interconnect';
import { createSharedCapabilities } from './interconnect/capabilities';
import { createRuntimeCapabilityProvider } from './interconnect/capability-runtime';
import { createWikiCapabilityProvider } from './interconnect/capability-wiki';
import { createPluginCapabilityProvider } from './app-plugins/remote-capabilities';
import { createAgentCapabilityProvider } from './interconnect/capability-agent';
import { createSharedFolders } from './interconnect/capability-folder';
import { registerIabHandlers } from '../api/ipc/iab-ipc';
import { registerAppPluginConfirmationHandlers } from '../api/ipc/app-plugin-confirmation';

const isE2EMode = process.env.MATCHACLAW_E2E === '1';
const e2eStartupOutcomeKey = '__matchaclawE2EStartupOutcome';
const directRuntimeHostDeliveryErrorCodes = new Set<DirectRuntimeHostDeliveryErrorCode>([
  'SPAWN_FAILED',
  'LAUNCH_ABORTED',
  'PROCESS_SCOPE_FAILED',
  'PROCESS_TREE_UNCONFIRMED',
  'READY_TIMEOUT',
  'CHILD_EXITED',
  'CHILD_FAILED',
  'STOP_FAILED',
  'FORCE_TERMINATION_FAILED',
]);
type E2EStartupOutcome =
  | Readonly<{ stage: 'bootstrap-resolve'; outcome: 'BOOTSTRAP_RESOLVE_FAILED' }>
  | Readonly<{
      stage: 'runtime-host-launch';
      outcome: DirectRuntimeHostDeliveryErrorCode | 'RUNTIME_HOST_LAUNCH_FAILED';
    }>
  | Readonly<{ stage: 'host-api'; outcome: 'HOST_API_FAILED' }>
  | Readonly<{ stage: 'ready'; outcome: 'started' }>;

const e2eLaunchDiagnosticKey = '__matchaclawE2ELaunchDiagnostic';

type E2EProcess = typeof process & {
  [e2eStartupOutcomeKey]?: E2EStartupOutcome;
  [e2eLaunchDiagnosticKey]?: Readonly<{
    code: DirectRuntimeHostDeliveryErrorCode;
    stderr: string;
  }>;
  __matchaclawE2ECronProviderTrace?: readonly string[];
};

function publishE2EStartupOutcome(outcome: E2EStartupOutcome): void {
  if (!isE2EMode || (process as E2EProcess)[e2eStartupOutcomeKey] !== undefined) return;

  Object.defineProperty(process as E2EProcess, e2eStartupOutcomeKey, {
    configurable: true,
    enumerable: false,
    value: Object.freeze(outcome),
    writable: false,
  });
}

function publishE2ECronProviderTrace(trace: readonly string[]): void {
  if (!isE2EMode || trace.length === 0) return;
  Object.defineProperty(process as E2EProcess, '__matchaclawE2ECronProviderTrace', {
    configurable: true,
    enumerable: false,
    value: Object.freeze([...trace]),
    writable: false,
  });
}

function registerGatewayControlUiSecurityHeaders(): void {
  session.defaultSession.webRequest.onHeadersReceived(
    { urls: ['http://127.0.0.1:18789/*', 'http://localhost:18789/*'] },
    (details, callback) => {
      const headers = { ...details.responseHeaders };
      delete headers['X-Frame-Options'];
      delete headers['x-frame-options'];
      if (headers['Content-Security-Policy']) {
        headers['Content-Security-Policy'] = headers['Content-Security-Policy'].map((csp) =>
          csp.replace(/frame-ancestors\s+'none'/g, "frame-ancestors 'self' *")
        );
      }
      if (headers['content-security-policy']) {
        headers['content-security-policy'] = headers['content-security-policy'].map((csp) =>
          csp.replace(/frame-ancestors\s+'none'/g, "frame-ancestors 'self' *")
        );
      }
      callback({ responseHeaders: headers });
    }
  );
}

function revealMainWindowAfterGatewayLeavesStopped(deps: {
  hostEventBus: HostEventBus;
  mainWindow: BrowserWindow;
}): void {
  const unsubscribe = deps.hostEventBus.on('gateway:status', (payload) => {
    if (!payload || typeof payload !== 'object') return;
    const processState = (payload as { processState?: unknown }).processState;
    if (processState === 'stopped') return;
    unsubscribe();
    if (!deps.mainWindow.isDestroyed()) {
      deps.mainWindow.show();
    }
  });
}

function registerMainWindowLifecycle(deps: {
  mainWindow: BrowserWindow;
  clearMainWindowRef: () => void;
}): void {
  deps.mainWindow.on('close', (event) => {
    if (!isQuitting()) {
      event.preventDefault();
      deps.mainWindow.hide();
    }
  });

  deps.mainWindow.on('closed', () => {
    deps.clearMainWindowRef();
  });
}

export type MainApplication = Readonly<{
  mainWindow: BrowserWindow;
  ready: Promise<void>;
  prepareQuit: () => Promise<void>;
  cancelQuit: () => void;
  close: () => Promise<void>;
  forceClose: () => Promise<void>;
  readShutdownStage: () => string;
}>;

export function bootstrapMainApplication(deps: {
  hostEventBus: HostEventBus;
  setMainWindow: (window: BrowserWindow | null) => void;
  getMainWindow: () => BrowserWindow | null;
}): MainApplication {
  logger.init();
  logger.info('=== MatchaClaw Application Starting ===');
  logger.debug(() =>
    `Runtime: platform=${process.platform}/${process.arch}, electron=${process.versions.electron}, node=${process.versions.node}, packaged=${app.isPackaged}`
  );

  if (!isE2EMode) {
    void warmupNetworkOptimization();
  } else {
    logger.info('E2E mode enabled: startup side effects are minimized');
  }

  const cloudAccountClient = createCloudAccountClient();

  createMenu();

  const mainWindow = createMainWindow({ showOnReady: !isE2EMode });
  deps.setMainWindow(mainWindow);
  registerMainWindowLifecycle({
    mainWindow,
    clearMainWindowRef: () => deps.setMainWindow(null),
  });
  if (!isE2EMode) {
    createTray(mainWindow, {
      checkForUpdates: () => appUpdater.checkForUpdates(),
    });
  }

  registerGatewayControlUiSecurityHeaders();
  const sessionObservers = new RendererSessionObservationRegistry();
  sessionObservers.attach(mainWindow.webContents);
  if (isE2EMode) {
    registerE2EUpdateHandlers();
  } else {
    appUpdater.configureUpdateSource();
    registerUpdateHandlers(appUpdater, mainWindow);
  }
  const stopMainEvents = registerMainEventBridge({
    hostEventBus: deps.hostEventBus,
    getMainWindow: deps.getMainWindow,
  });
  const licenseService = composeLicenseService({
    onGateChanged: (snapshot) => deps.hostEventBus.emit('license:gate-changed', snapshot),
  });
  const appPluginRoot = join(app.getPath('userData'), 'app-plugins');
  const appPluginPackages = new AppPluginPackageWorker();
  const appPlugins = new ApplicationPluginOwner({
    rootDir: appPluginRoot, packageWorker: appPluginPackages,
    onChanged: async (event, catalog) => {
      const retired = appPluginHost.changed(catalog);
      void appPluginAgentGateway.then((gateway) => gateway.changed(), () => undefined);
      deps.hostEventBus.emit('app-plugins:changed', event);
      await retired;
    },
  });
  const generateText: AppPluginHostOptions['generateText'] = async (request, signal) => {
    await apiRuntime;
    signal.throwIfAborted();
    if (!delivery) throw new Error('Model delivery is unavailable.');
    return generatePluginText(delivery.issuer, delivery.runtimeHostTransportPort, request, signal);
  };
  const appPluginExecutionTargets = registerAppPluginExecutionTargets(mainWindow);
  const appPluginExecution = createAppPluginExecution({
    getTransports: async () => { await apiRuntime; return transportBundle!; },
    listTeams: async () => ({ teams: appPluginExecutionTargets.listTeams() }),
  });
  const appPluginServices = createAppPluginServices({
    rootDir: appPluginRoot,
    getTransports: async () => { await apiRuntime; return transportBundle!.hostApiTransports; },
  });
  const appPluginHost = new AppPluginHost({
    rootDir: appPluginRoot, owner: appPlugins, packageWorker: appPluginPackages,
    execute: appPluginExecution.execute,
    service: appPluginServices.service,
    publish: (event) => deps.hostEventBus.emit('app-plugins:runtime', event),
    publishConfirmation: (event) => deps.hostEventBus.emit('app-plugins:confirmation', event),
    list: async (request, signal) => {
      await apiRuntime;
      signal.throwIfAborted();
      if (!delivery) throw new Error('Model delivery is unavailable.');
      return listPluginMediaModels(delivery.issuer, delivery.runtimeHostTransportPort, request, signal);
    },
    submitVideo: async (request, signal) => {
      await apiRuntime;
      signal.throwIfAborted();
      if (!delivery) throw new Error('Model delivery is unavailable.');
      return submitPluginVideo(delivery.issuer, delivery.runtimeHostTransportPort, request, signal);
    },
    queryVideo: async (request, signal) => {
      await apiRuntime;
      signal.throwIfAborted();
      if (!delivery) throw new Error('Model delivery is unavailable.');
      return queryPluginVideo(delivery.issuer, delivery.runtimeHostTransportPort, request, signal);
    },
    collectVideo: async (request, signal) => {
      await apiRuntime;
      signal.throwIfAborted();
      if (!delivery) throw new Error('Model delivery is unavailable.');
      return collectPluginVideo(delivery.issuer, delivery.runtimeHostTransportPort, request, signal);
    },
    generateText,
    generateSpeech: async (request, signal) => {
      await apiRuntime;
      signal.throwIfAborted();
      if (!delivery) throw new Error('Model delivery is unavailable.');
      return generatePluginAudio(delivery.issuer, delivery.runtimeHostTransportPort, 'tts', request, signal);
    },
    transcribe: async (request, signal) => {
      await apiRuntime;
      signal.throwIfAborted();
      if (!delivery) throw new Error('Model delivery is unavailable.');
      return generatePluginAudio(delivery.issuer, delivery.runtimeHostTransportPort, 'transcribe', request, signal);
    },
    generateMusic: async (request, signal) => {
      await apiRuntime;
      signal.throwIfAborted();
      if (!delivery) throw new Error('Model delivery is unavailable.');
      return generatePluginAudio(delivery.issuer, delivery.runtimeHostTransportPort, 'music', request, signal);
    },
    generate: async (request, signal) => {
      await apiRuntime;
      signal.throwIfAborted();
      if (!delivery) throw new Error('Model delivery is unavailable.');
      return generatePluginMedia(delivery.issuer, delivery.runtimeHostTransportPort, request, signal);
    },
  });
  const stopAppPluginConfirmation = registerAppPluginConfirmationHandlers(appPluginHost, mainWindow);
  const bundledAppPluginsReady = app.isPackaged
    ? appPlugins.installBundled(join(process.resourcesPath, 'app-plugins', 'bundled'))
    : Promise.resolve();
  void bundledAppPluginsReady.catch(() => undefined);
  const appPluginAgentGateway = bundledAppPluginsReady.then(() => startAppPluginAgentGateway({
    owner: appPlugins, host: appPluginHost,
    onPreview: (developmentId) => deps.hostEventBus.emit('app-plugins:preview', { developmentId }),
    root: join(app.getPath('userData'), 'app-plugin-agent'),
    sdkArchive: app.isPackaged ? join(process.resourcesPath, 'app-plugins', 'sdk.tgz') : join(app.getAppPath(), 'sdk', 'app-plugins', 'matcha-app-plugins-sdk-1.2.0.tgz'),
  }));
  const appPluginGatewaySettled = appPluginAgentGateway.then(() => undefined, () => {
    logger.warn('[AppPlugins] Agent SDK gateway unavailable; existing runtimes will start without plugin development tools');
  });
  const shutdown = new AbortController();
  const access = createAccess({ root: join(getRuntimeHostStateDir(), 'access') });
  const networkAccess = createNetworkAccess({
    root: join(app.getPath('userData'), 'network-access'),
    getHostName: async () => {
      const response = await access.read(shutdown.signal);
      if (response.status !== 200) throw new Error(response.body.error);
      return response.body.host.name;
    },
    receive: async (request, signal) => {
      if (signal.aborted || shutdown.signal.aborted) return { status: 503, body: { success: false, error: 'unavailable' } };
      if ('kind' in request && request.kind === 'interconnect') {
        const response = await (await interconnect).receive(request as import('../../src/types/desktop/interconnect').InterconnectEnvelope);
        return 'kind' in response ? response : { status: 503, body: { success: false, error: 'unavailable' } };
      }
      return { status: 400, body: { success: false, error: 'invalid-request' } };
    },
  });
  void networkAccess.catch(() => undefined);
  const sharedFolders = createSharedFolders();
  const interconnect = createInterconnect({
    root: join(app.getPath('userData'), 'interconnect'), network: networkAccess, signal: shutdown.signal,
    access, folders: sharedFolders,
    capabilities: createSharedCapabilities([
      createRuntimeCapabilityProvider(async () => { await apiRuntime; return transportBundle!.hostApiTransports; }),
      createWikiCapabilityProvider(async () => { await apiRuntime; return transportBundle!.hostApiTransports; }),
      createPluginCapabilityProvider(appPlugins, appPluginHost),
      createAgentCapabilityProvider(async () => { await apiRuntime; return transportBundle!; }),
      { id: 'folders', async list() {
        const response = await access.folders(shutdown.signal);
        if (response.status !== 200) throw new Error('Shared folders are unavailable.');
        return response.body.map(sharedFolders.folderCapability);
      } },
    ]),
  });
  void interconnect.catch(() => undefined);
  const iab = createIab({
    window: deps.getMainWindow,
    emit: (event) => deps.hostEventBus.emit('iab:event', event),
    isAgentEnabled: async () => (await (await apiRuntime).runtimeHostTransports.settingsDesiredTransport.read())?.browserMode === 'iab',
    runtime: async () => (await apiRuntime).runtimeHost,
  });
  const stopIabIpc = registerIabHandlers(iab, deps.getMainWindow);
  const heldRuntimeHosts = new Set<DirectRuntimeHost>();
  let shutdownStage = 'running';
  let closeTask: Promise<void> | undefined;
  let forceCloseTask: Promise<void> | undefined;
  let delivery: RuntimeHostDelivery | undefined;
  let startedRuntimeHost: DirectRuntimeHost | undefined;
  let directRuntimeHost: RuntimeHostLifecycleOwner | undefined;
  let transportBundle: RuntimeHostTransportBundle | undefined;
  let channelAuthorization: ReturnType<typeof createChannelAuthorization> | undefined;
  let runtimeReady = false;
  const subscriptions: (() => void)[] = [stopMainEvents];
  const assertStarting = () => {
    if (shutdown.signal.aborted || isQuitting()) throw new Error('Application is shutting down');
  };

  const runtimeSetup = (async (): Promise<{
    api: RuntimeHostApiDependencies;
    account: CloudAccountRuntime;
    providerAuth: ProviderPrivateAuthDependencies;
  }> => {
    try {
      assertStarting();
      await bundledAppPluginsReady;
      assertStarting();
      await appPluginGatewaySettled;
      assertStarting();
      delivery = await createRuntimeHostDelivery(deps.hostEventBus, {
        signal: shutdown.signal,
        onSpawn: (host, closed) => {
          heldRuntimeHosts.add(host);
          void closed.then(() => heldRuntimeHosts.delete(host), () => undefined);
        },
      });
      assertStarting();
      startedRuntimeHost = await delivery.launchRuntimeHost();
      assertStarting();
      const runtimeHost = new RuntimeHostLifecycleOwner(startedRuntimeHost, delivery.launchRuntimeHost);
      directRuntimeHost = runtimeHost;
      const runtimeStatus = new RuntimeStatusProjection(runtimeHost);
      const bundle = createRuntimeHostTransportBundle({
        issuer: delivery.issuer,
        runtimeHostTransportPort: delivery.runtimeHostTransportPort,
        onBrowserModeChanging: iab.beginBrowserModeChange,
        reportE2ECronTrace: isE2EMode
          ? async (stage) => {
              await new Promise<void>((resolve) => setTimeout(resolve, 0));
              publishE2ECronProviderTrace([...runtimeHost.readE2ECronProviderTrace(), stage]);
            }
          : undefined,
      });
      transportBundle = bundle;
      const transports = bundle.hostApiTransports;
      channelAuthorization = createChannelAuthorization(transports.channelCatalogTransport.apply, shutdown.signal);
      sessionObservers.setNativeRelease(async (identity, leaseId) => {
        const response = await transports.sessionObservationTransport.release(observationRequest(identity, leaseId, 'sessions.release'));
        if (response.status !== 200) throw new Error('Session observation release is unavailable');
      });
      const subscribeCalls = createCallSubscriber(deps.hostEventBus, runtimeHost);
      const awaitProviderCall = createProviderCallObserver(transports.callLogTransport, subscribeCalls);
      const providerSync = createCloudProviderSync({
        fetchClientBootstrap: (token) => cloudAccountClient.fetchClientBootstrap(token),
        providerAccountsTransport: transports.providerAccountsTransport,
        providerModelsTransport: transports.providerModelsTransport,
        awaitProviderCall,
        onChanged: () => deps.hostEventBus.emit('providers:changed', {}),
      });
      subscriptions.push(
        runtimeHost.onDisconnect(() => iab.invalidateAgentControl()),
        runtimeHost.onExit(() => cloudAccountService.runtimeExited()),
        runtimeHost.onRestart(() => {
          void cloudAccountService.runtimeRestarted().catch(() => logger.warn('Cloud package authorization restore failed'));
        }),
      );
      registerRuntimeIpcHandlers(
        runtimeHost,
        transports.fleetCredentialsTransport,
        createDiagnosticsExportDependencies(transports.diagnosticsArchiveTransport),
      );
      subscriptions.push(registerHostEventBridge({
        runtimeHost,
        runtimeStatus,
        hostEventBus: deps.hostEventBus,
        getMainWindow: deps.getMainWindow,
        sessionObservers,
        sessionEvents: bundle.sessionEventsTransport,
        resyncSessions: () => sessionObservers.resync(async (identity, leaseId) => {
          const response = await transports.sessionObservationTransport.observe(
            observationRequest(identity, leaseId, 'sessions.observe'));
          return response.status === 200 && 'leaseId' in response.body ? response.body : null;
        }),
      }));
      const result = {
        api: {
          runtimeHost,
          runtimeStatus,
          channelAuthorization,
          runtimeHostTransports: transports,
          providerCredentialStatusTransport: createProviderCredentialStatusTransport(),
          generatePluginText: generateText,
          credentialWriteAdapter: createFleetCredentialWriteAdapter(transports.fleetCredentialsTransport),
          runtimeHostTransportPort: delivery.runtimeHostTransportPort,
        },
        account: {
          providerSync,
          packageTransport: transports.sealedResourceAuthorizationTransport,
          operationTransports: {
            agentsTransport: transports.agentsTransport,
            sealedSkillsTransport: transports.sealedSkillsTransport,
            callLogTransport: transports.callLogTransport,
            subscribeCalls,
            packageChanged: (operationId) => deps.hostEventBus.emit('package:changed', { operationId }),
          },
        },
        providerAuth: { transport: transports.providerAccountsTransport, modelsTransport: transports.providerModelsTransport, awaitProviderCall },
      } satisfies {
        api: RuntimeHostApiDependencies;
        account: CloudAccountRuntime;
        providerAuth: ProviderPrivateAuthDependencies;
      };
      runtimeReady = true;
      return result;
    } catch (error) {
      publishE2ELaunchDiagnostic(error);
      if (isDirectRuntimeHostDeliveryError(error) && error.diagnostic?.stderr) {
        logger.error(`[RuntimeHost] launch diagnostic: ${error.diagnostic.stderr}`);
      }
      publishE2EStartupOutcome(classifyBootstrapStartupFailure(error));
      throw error;
    }
  })();
  const accountRuntime = runtimeSetup.then(({ account }) => account);
  void accountRuntime.catch(() => undefined);
  const cloudAccountService = createCloudAccountService(cloudAccountClient, accountRuntime);
  const apiRuntime = runtimeSetup.then(({ api }) => api);
  void apiRuntime.catch(() => undefined);
  void apiRuntime.then(async () => {
    shutdown.signal.throwIfAborted();
    await appPluginHost.start(await appPlugins.list());
  }).catch(() => logger.warn('[AppPlugins] Background application activation did not complete'));
  const apiContext = {
    licenseService,
    cloudAccountService,
    appPlugins,
    appPluginHost,
    appPluginAgentGateway,
    access,
    networkAccess,
    interconnect,
    eventBus: deps.hostEventBus,
    sessionObservers,
    runtime: apiRuntime,
    signal: shutdown.signal,
  };
  const dispatchHostApi = createHostApiDispatcher(apiContext);
  registerStaticIpcHandlers(deps.getMainWindow, dispatchHostApi, apiRuntime, sessionObservers, shutdown.signal);
  const providerAuthRuntime = runtimeSetup.then((runtime) => runtime.providerAuth);
  void providerAuthRuntime.catch(() => undefined);
  const providerAuth = createProviderPrivateAuth(deps.getMainWindow, providerAuthRuntime, shutdown.signal);
  registerProviderPrivateAuthHandlers(providerAuth);
  void networkAccess.then((network) => network.startConfigured()).catch(() => logger.warn('[Access] Network component could not start'));
  const worldPrivate = createWorldPrivateOperations(
    runtimeSetup.then(({ api }) => api.runtimeHostTransports.worldTransport), shutdown.signal,
    apiRuntime.then(({ runtimeHost }) => runtimeHost),
    {
      getMainWindow: deps.getMainWindow,
      authorizeInitialImport: async () => {
        const account = await cloudAccountService.getSession().catch(() => null);
        return account?.state === 'authenticated' || (await licenseService.gate()).state === 'granted';
      },
      validateStorageBootstrap: async (storage, configuration) => {
        await apiRuntime;
        if (!delivery) throw new Error('world.initial_host_unavailable');
        await delivery.validateWorldStorageBootstrap(storage, configuration);
      },
    },
  );
  registerWorldPrivateHandlers(worldPrivate);
  let server: Server | undefined;
  const startup = (async () => {
    server = startHostApiServer(apiContext, undefined, dispatchHostApi);
    const listening = waitForHostApiServerListening(server);
    const [{ api }] = await Promise.all([runtimeSetup, listening]);
    assertStarting();
    if (!isE2EMode) {
      const settings = await api.runtimeHostTransports.settingsDesiredTransport.read().catch(() => null);
      assertStarting();
      if (!settings || !(await applyLaunchAtStartupSetting(settings.launchAtStartup))) {
        logger.warn('Launch-at-startup setting could not be applied during startup');
      }
    }
    assertStarting();
    if (isE2EMode) {
      revealMainWindowAfterGatewayLeavesStopped({ hostEventBus: deps.hostEventBus, mainWindow });
    }
    publishE2EStartupOutcome({ stage: 'ready', outcome: 'started' });
  })();
  const close = (): Promise<void> => {
    if (closeTask) return closeTask;
    shutdown.abort();
    shutdownStage = 'host-api';
    closeTask = (async () => {
      const hostApiServer = server;
      const serverClosed = hostApiServer && new Promise<void>((resolve, reject) => {
        hostApiServer.close((error?: NodeJS.ErrnoException) => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve());
        hostApiServer.closeAllConnections();
      });
      void serverClosed?.catch(() => undefined);
      const interconnectClosed = interconnect.then((owner) => owner.close(), () => undefined).finally(() => sharedFolders.close());
      void interconnectClosed.catch(() => undefined);
      const appPluginsClosed = appPluginAgentGateway.then((gateway) => gateway.close(), () => undefined)
        .finally(() => appPluginHost.close()).finally(() => appPlugins.close()).finally(() => appPluginPackages.close());
      void appPluginsClosed.catch(() => undefined);
      stopIabIpc();
      stopAppPluginConfirmation();
      appPluginExecutionTargets.close();
      const iabClosed = iab.close();
      void iabClosed.catch(() => undefined);
      shutdownStage = 'startup';
      await Promise.allSettled([runtimeSetup, startup]);
      if (!runtimeReady) cloudAccountService.runtimeExited();
      try {
        try {
          shutdownStage = 'license';
          await licenseService.dispose();
        } finally {
          shutdownStage = 'session-observations';
          await sessionObservers.close().catch(() => logger.warn('Failed to release session observations during application close'));
          shutdownStage = 'cloud-account';
          await cloudAccountService.close();
        }
      } finally {
        shutdownStage = 'provider-auth';
        await providerAuth.drain();
        shutdownStage = 'world-private';
        await worldPrivate.drain();
        shutdownStage = 'channel-authorization';
        await channelAuthorization?.drain();
        for (const unsubscribe of subscriptions) unsubscribe();
        try {
          try {
            shutdownStage = 'iab';
            await iabClosed;
          } finally {
            try {
              shutdownStage = 'network-access';
              try { await interconnectClosed; }
              finally {
                try { await networkAccess.then((network) => network.close()); }
                finally { await access.close(); }
              }
            } finally {
              shutdownStage = 'runtime-host';
              const runtimeHost = directRuntimeHost ?? startedRuntimeHost;
              if (runtimeHost) await runtimeHost.stop();
            }
          }
        } finally {
          shutdownStage = 'delivery';
          transportBundle?.close();
          await delivery?.close();
          shutdownStage = 'app-plugins';
          try { await appPluginsClosed; }
          finally {
            shutdownStage = 'host-api';
            await serverClosed;
          }
        }
      }
      shutdownStage = 'completed';
    })();
    return closeTask;
  };
  const forceClose = (): Promise<void> => {
    shutdown.abort();
    forceCloseTask ??= (async () => {
      const results = await Promise.allSettled([interconnect.then((owner) => owner.close(), () => undefined).finally(() => sharedFolders.close()), networkAccess.then((network) => network.close()), access.close(), iab.close(), appPluginAgentGateway.then((gateway) => gateway.forceClose(), () => undefined), appPluginHost.forceClose(), appPlugins.close(), appPluginPackages.forceClose(), ...[...heldRuntimeHosts].map((host) => host.forceKill())]);
      const failures = results.filter((result) => result.status === 'rejected');
      if (failures.length > 0) {
        throw new AggregateError(failures.map((result) => result.reason), 'Runtime-host force confirmation failed');
      }
    })();
    return forceCloseTask;
  };
  const ready = startup.catch(async (error) => {
    publishE2EStartupOutcome({ stage: 'host-api', outcome: 'HOST_API_FAILED' });
    await close().catch(() => logger.warn('Failed to clean up application startup'));
    throw error;
  });
  cloudAccountService.prewarm();
  loadMainWindowContent(mainWindow);
  return { mainWindow, ready, prepareQuit: () => iab.prepareQuit(), cancelQuit: () => iab.cancelQuit(), close, forceClose, readShutdownStage: () => shutdownStage };
}

function publishE2ELaunchDiagnostic(error: unknown): void {
  if (!isE2EMode || !isDirectRuntimeHostDeliveryError(error)) return;

  const diagnostic = (error as DirectRuntimeHostDeliveryError).diagnostic;
  if (!diagnostic || (process as E2EProcess)[e2eLaunchDiagnosticKey] !== undefined) return;

  Object.defineProperty(process as E2EProcess, e2eLaunchDiagnosticKey, {
    configurable: true,
    enumerable: false,
    value: Object.freeze({
      code: error.code,
      stderr: diagnostic.stderr,
    }),
    writable: false,
  });
}

function classifyBootstrapStartupFailure(error: unknown): E2EStartupOutcome {
  return {
    stage: 'runtime-host-launch',
    outcome: classifyRuntimeHostLaunchFailure(error),
  };
}

function classifyRuntimeHostLaunchFailure(error: unknown): Extract<E2EStartupOutcome, { stage: 'runtime-host-launch' }>['outcome'] {
  if (isDirectRuntimeHostDeliveryError(error)) return error.code;
  return 'RUNTIME_HOST_LAUNCH_FAILED';
}

function isDirectRuntimeHostDeliveryError(
  error: unknown
): error is DirectRuntimeHostDeliveryError {
  return (
    error instanceof Error &&
    error.name === 'DirectRuntimeHostDeliveryError' &&
    directRuntimeHostDeliveryErrorCodes.has(
      (error as { code?: unknown }).code as DirectRuntimeHostDeliveryErrorCode
    )
  );
}
