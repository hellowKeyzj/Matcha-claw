import { app, session, type BrowserWindow } from 'electron';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { ApplicationPluginOwner } from './app-plugins/owner';
import { startAppPluginAgentGateway } from './app-plugins/agent-gateway';
import type { RuntimeHostApiDependencies } from '../api/context';
import {
  registerRuntimeIpcHandlers,
  registerStaticIpcHandlers,
} from './ipc-handlers';
import { createTray } from './tray';
import { createMenu } from './menu';
import { appUpdater, registerE2EUpdateHandlers, registerUpdateHandlers } from './updater';
import { logger } from '../utils/logger';
import { warmupNetworkOptimization } from '../utils/uv-env';
import type { HostEventBus } from '../api/event-bus';
import { startHostApiServer, waitForHostApiServerListening } from '../api/server';
import { registerHostEventBridge, registerMainEventBridge } from './host-event-bridge';
import { RendererSessionObservationRegistry } from './renderer-event-routes';
import { observationRequest } from './runtime-host-delivery/transport/sessions/observation';
import { createMainWindow, loadMainWindowContent } from './main-window';
import { isQuitting } from './app-state';
import { applyLaunchAtStartupSetting } from './launch-at-startup';
import {
  type DirectRuntimeHost,
  type DirectRuntimeHostDeliveryError,
  type DirectRuntimeHostDeliveryErrorCode,
} from './runtime-host-delivery/direct-host';
import { createRuntimeHostDelivery, type RuntimeHostDelivery } from './runtime-host-delivery/delivery';
import { RuntimeHostLifecycleOwner } from './runtime-host-delivery/lifecycle-owner';
import { createCloudAccountClient } from './cloud-account/client';
import { createCloudAccountService, type CloudAccountRuntime } from './cloud-account/service';
import { createCloudProviderSync } from './cloud-account/provider-sync';
import { createProviderCallObserver } from './ipc/provider-call-observation';
import { createCallSubscriber } from './call-observation';
import { createDiagnosticsExportDependencies } from './ipc/diagnostics-export-ipc';
import {
  createRuntimeHostTransportBundle,
  type RuntimeHostTransportBundle,
} from './runtime-host-delivery/transport/bundle';
import {
  createProviderCredentialStatusTransport,
  registerProviderPrivateAuthHandlers,
  type ProviderPrivateAccountDependencies,
} from './ipc/provider-private-auth';
import { createFleetCredentialWriteAdapter } from './ipc/fleet-private';
import { registerWorldPrivateHandlers } from './world/private-ipc';
import { composeLicenseService } from './license/composition';

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
    registerUpdateHandlers(appUpdater, mainWindow);
  }
  const stopMainEvents = registerMainEventBridge({
    hostEventBus: deps.hostEventBus,
    getMainWindow: deps.getMainWindow,
  });
  const licenseService = composeLicenseService({
    onGateChanged: (snapshot) => deps.hostEventBus.emit('license:gate-changed', snapshot),
  });
  const appPlugins = new ApplicationPluginOwner({
    rootDir: join(app.getPath('userData'), 'app-plugins'),
    onChanged: (event) => deps.hostEventBus.emit('app-plugins:changed', event),
  });
  const appPluginAgentGateway = startAppPluginAgentGateway({
    owner: appPlugins,
    root: join(app.getPath('userData'), 'app-plugin-agent'),
  });
  const appPluginGatewaySettled = appPluginAgentGateway.then(() => undefined, () => {
    logger.warn('[AppPlugins] Agent SDK gateway unavailable; existing runtimes will start without plugin development tools');
  });
  const shutdown = new AbortController();
  const heldRuntimeHosts = new Set<DirectRuntimeHost>();
  let shutdownStage = 'running';
  let closeTask: Promise<void> | undefined;
  let forceCloseTask: Promise<void> | undefined;
  let delivery: RuntimeHostDelivery | undefined;
  let startedRuntimeHost: DirectRuntimeHost | undefined;
  let directRuntimeHost: RuntimeHostLifecycleOwner | undefined;
  let transportBundle: RuntimeHostTransportBundle | undefined;
  let runtimeReady = false;
  const subscriptions: (() => void)[] = [stopMainEvents];
  const assertStarting = () => {
    if (shutdown.signal.aborted || isQuitting()) throw new Error('Application is shutting down');
  };

  const runtimeSetup = (async (): Promise<{
    api: RuntimeHostApiDependencies;
    account: CloudAccountRuntime;
    providerAuth: ProviderPrivateAccountDependencies;
  }> => {
    try {
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
      const bundle = createRuntimeHostTransportBundle({
        issuer: delivery.issuer,
        runtimeHostTransportPort: delivery.runtimeHostTransportPort,
        reportE2ECronTrace: isE2EMode
          ? async (stage) => {
              await new Promise<void>((resolve) => setTimeout(resolve, 0));
              publishE2ECronProviderTrace([...runtimeHost.readE2ECronProviderTrace(), stage]);
            }
          : undefined,
      });
      transportBundle = bundle;
      const transports = bundle.hostApiTransports;
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
      });
      subscriptions.push(
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
          runtimeHostTransports: transports,
          providerCredentialStatusTransport: createProviderCredentialStatusTransport(),
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
        providerAuth: { transport: transports.providerAccountsTransport, awaitProviderCall },
      } satisfies {
        api: RuntimeHostApiDependencies;
        account: CloudAccountRuntime;
        providerAuth: ProviderPrivateAccountDependencies;
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
  registerStaticIpcHandlers(deps.getMainWindow, apiRuntime, sessionObservers);
  const providerAuth = runtimeSetup.then((runtime) => runtime.providerAuth);
  void providerAuth.catch(() => undefined);
  const drainProviderAuth = registerProviderPrivateAuthHandlers(deps.getMainWindow, providerAuth, shutdown.signal);
  const drainWorldPrivate = registerWorldPrivateHandlers(
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
  let server: Server | undefined;
  const startup = (async () => {
    server = startHostApiServer({
      licenseService,
      cloudAccountService,
      appPlugins,
      appPluginAgentGateway,
      eventBus: deps.hostEventBus,
      sessionObservers,
      runtime: apiRuntime,
      signal: shutdown.signal,
    });
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
      const appPluginsClosed = appPluginAgentGateway.then((gateway) => gateway.close(), () => undefined)
        .finally(() => appPlugins.close());
      void appPluginsClosed.catch(() => undefined);
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
        await drainProviderAuth();
        shutdownStage = 'world-private';
        await drainWorldPrivate();
        for (const unsubscribe of subscriptions) unsubscribe();
        try {
          shutdownStage = 'runtime-host';
          const runtimeHost = directRuntimeHost ?? startedRuntimeHost;
          if (runtimeHost) await runtimeHost.stop();
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
      const results = await Promise.allSettled([...heldRuntimeHosts].map((host) => host.forceKill()));
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
  return { mainWindow, ready, close, forceClose, readShutdownStage: () => shutdownStage };
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
