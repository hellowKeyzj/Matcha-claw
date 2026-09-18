import { app, session, type BrowserWindow } from 'electron';
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
import { registerHostEventBridge } from './host-event-bridge';
import { RendererEventRouteRegistry } from './renderer-event-routes';
import { createMainWindow, loadMainWindowContent } from './main-window';
import { isQuitting } from './app-state';
import { applyLaunchAtStartupSetting } from './launch-at-startup';
import {
  type DirectRuntimeHost,
  type DirectRuntimeHostDeliveryError,
  type DirectRuntimeHostDeliveryErrorCode,
} from './runtime-host-delivery/direct-host';
import { createRuntimeHostDelivery, type RuntimeHostDelivery } from './runtime-host-delivery/delivery';
import { RuntimeHostLifecycleOwner, stopOrForceKillRuntimeHost } from './runtime-host-delivery/lifecycle-owner';
import { createCloudAccountClient } from './cloud-account/client';
import { createCloudAccountService } from './cloud-account/service';
import { createCloudProviderSync } from './cloud-account/provider-sync';
import { createDiagnosticsExportDependencies } from './ipc/diagnostics-export-ipc';
import {
  createRuntimeHostTransportBundle,
  type RuntimeHostTransportBundle,
} from './runtime-host-delivery/transport/bundle';
import {
  createProviderCredentialStatusTransport,
  type ProviderCredentialStatusTransport,
} from './ipc/provider-private-auth';

const isE2EMode = process.env.MATCHACLAW_E2E === '1';
const e2eStartupOutcomeKey = '__matchaclawE2EStartupOutcome';
const directRuntimeHostDeliveryErrorCodes = new Set<DirectRuntimeHostDeliveryErrorCode>([
  'SPAWN_FAILED',
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

export async function bootstrapMainApplication(deps: {
  hostEventBus: HostEventBus;
  setMainWindow: (window: BrowserWindow | null) => void;
  getMainWindow: () => BrowserWindow | null;
}): Promise<{
  mainWindow: BrowserWindow;
  directRuntimeHost: RuntimeHostLifecycleOwner;
  closeRuntimeHostDelivery: () => Promise<void>;
}> {
  logger.init();
  logger.info('=== MatchaClaw Application Starting ===');
  logger.debug(
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
  registerStaticIpcHandlers(deps.getMainWindow);
  if (isE2EMode) {
    registerE2EUpdateHandlers();
  } else {
    registerUpdateHandlers(appUpdater, mainWindow);
  }
  loadMainWindowContent(mainWindow);
  const rendererEventRoutes = new RendererEventRouteRegistry();
  let directRuntimeHost: RuntimeHostLifecycleOwner;
  let startedRuntimeHost: DirectRuntimeHost | undefined;
  let closeRuntimeHostDelivery: (() => Promise<void>) | undefined;
  let transportBundle: RuntimeHostTransportBundle;
  let providerCredentialStatusTransport: ProviderCredentialStatusTransport;
  let cloudAccountService: ReturnType<typeof createCloudAccountService>;
  let delivery: RuntimeHostDelivery;
  try {
    delivery = await createRuntimeHostDelivery(deps.hostEventBus);
    closeRuntimeHostDelivery = delivery.close;
    const initialRuntimeHost = await delivery.launchRuntimeHost();
    startedRuntimeHost = initialRuntimeHost;
    directRuntimeHost = new RuntimeHostLifecycleOwner(
      initialRuntimeHost,
      delivery.launchRuntimeHost,
    );
    transportBundle = createRuntimeHostTransportBundle({
      issuer: delivery.issuer,
      runtimeHostTransportPort: delivery.runtimeHostTransportPort,
      reportE2ECronTrace: isE2EMode
        ? async (stage) => {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            publishE2ECronProviderTrace([...directRuntimeHost.readE2ECronProviderTrace(), stage]);
          }
        : undefined,
    });
    closeRuntimeHostDelivery = async () => {
      transportBundle.close();
      await delivery.close();
    };
    providerCredentialStatusTransport = createProviderCredentialStatusTransport();
    const cloudProviderSync = createCloudProviderSync({
      fetchClientBootstrap: (token) => cloudAccountClient.fetchClientBootstrap(token),
      providerAccountsTransport: transportBundle.hostApiTransports.providerAccountsTransport,
      providerModelsTransport: transportBundle.hostApiTransports.providerModelsTransport,
    });
    cloudAccountService = createCloudAccountService(cloudAccountClient, cloudProviderSync);
    cloudAccountService.prewarm();
  } catch (error) {
    if (startedRuntimeHost) {
      await stopOrForceKillRuntimeHost(startedRuntimeHost).catch(() => undefined);
    }
    await closeRuntimeHostDelivery?.().catch(() => undefined);
    publishE2ELaunchDiagnostic(error);
    if (isDirectRuntimeHostDeliveryError(error) && error.diagnostic?.stderr) {
      logger.error(`[RuntimeHost] launch diagnostic: ${error.diagnostic.stderr}`);
    }
    publishE2EStartupOutcome(classifyBootstrapStartupFailure(error));
    throw error;
  }

  try {
    await waitForHostApiServerListening(
      startHostApiServer({
        cloudAccountService,
        eventBus: deps.hostEventBus,
        runtimeHost: directRuntimeHost,
        rendererEventRoutes,
        runtimeHostTransports: transportBundle.hostApiTransports,
        providerCredentialStatusTransport,
      }, undefined, delivery.runtimeHostTransportPort)
    );

    registerRuntimeIpcHandlers(
      directRuntimeHost,
      deps.getMainWindow,
      transportBundle.hostApiTransports.providerAccountsTransport,
      createDiagnosticsExportDependencies(transportBundle.hostApiTransports.diagnosticsArchiveTransport),
    );
    registerHostEventBridge({
      runtimeHost: directRuntimeHost,
      hostEventBus: deps.hostEventBus,
      getMainWindow: deps.getMainWindow,
      rendererEventRoutes,
      sessionEvents: transportBundle.sessionEventsTransport,
    });

    if (!isE2EMode) {
      const settings = await transportBundle.hostApiTransports.settingsDesiredTransport.read().catch(() => null);
      if (!settings || !(await applyLaunchAtStartupSetting(settings.launchAtStartup))) {
        logger.warn('Launch-at-startup setting could not be applied during startup');
      }
    }

    if (isE2EMode) {
      revealMainWindowAfterGatewayLeavesStopped({
        hostEventBus: deps.hostEventBus,
        mainWindow,
      });
    }

    publishE2EStartupOutcome({ stage: 'ready', outcome: 'started' });
    return {
      mainWindow,
      directRuntimeHost,
      closeRuntimeHostDelivery: closeRuntimeHostDelivery ?? (async () => undefined),
    };
  } catch (error) {
    publishE2EStartupOutcome({ stage: 'host-api', outcome: 'HOST_API_FAILED' });
    await stopOrForceKillRuntimeHost(directRuntimeHost).catch(() => undefined);
    await closeRuntimeHostDelivery?.().catch(() => undefined);
    throw error;
  }
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
