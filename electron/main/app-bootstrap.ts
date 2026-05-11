import { app, session, type BrowserWindow } from 'electron';
import type { Server } from 'node:http';
import type { GatewayManager } from '../gateway/manager';
import { registerIpcHandlers } from './ipc-handlers';
import { createTray } from './tray';
import { createMenu } from './menu';
import { appUpdater, registerUpdateHandlers } from './updater';
import { logger } from '../utils/logger';
import { warmupNetworkOptimization } from '../utils/uv-env';
import { autoInstallCliIfNeeded, generateCompletionCache, installCompletionToProfile } from '../services/openclaw/openclaw-cli-service';
import { applyProxySettings } from './proxy';
import { applyLaunchAtStartupSetting } from './launch-at-startup';
import { loadHostBootstrapSettings } from '../gateway/config-sync';
import { startHostApiServer, waitForHostApiServerListening } from '../api/server';
import type { HostEventBus } from '../api/event-bus';
import type { RuntimeHostManager } from './runtime-host-manager';
import { emitHostEvent, registerHostEventBridge } from './host-event-bridge';
import { createMainWindow, loadMainWindowContent } from './main-window';
import { isQuitting } from './app-state';
import { waitForRuntimeHostJob, type RuntimeHostJobSnapshot } from './runtime-host-jobs';

const isE2EMode = process.env.CLAWX_E2E === '1';

type HostBootstrapSettings = {
  launchAtStartup: boolean;
  gatewayAutoStart: boolean;
  gatewayToken: string;
  proxyEnabled: boolean;
  proxyServer: string;
  proxyBypassRules: string;
};

function registerGatewayControlUiSecurityHeaders(): void {
  session.defaultSession.webRequest.onHeadersReceived(
    { urls: ['http://127.0.0.1:18789/*', 'http://localhost:18789/*'] },
    (details, callback) => {
      const headers = { ...details.responseHeaders };
      delete headers['X-Frame-Options'];
      delete headers['x-frame-options'];
      if (headers['Content-Security-Policy']) {
        headers['Content-Security-Policy'] = headers['Content-Security-Policy'].map(
          (csp) => csp.replace(/frame-ancestors\s+'none'/g, "frame-ancestors 'self' *"),
        );
      }
      if (headers['content-security-policy']) {
        headers['content-security-policy'] = headers['content-security-policy'].map(
          (csp) => csp.replace(/frame-ancestors\s+'none'/g, "frame-ancestors 'self' *"),
        );
      }
      callback({ responseHeaders: headers });
    },
  );
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

function startNonBlockingBootstrapTasks(deps: {
  mainWindow: BrowserWindow;
  hostEventBus: HostEventBus;
}): void {
  void autoInstallCliIfNeeded((installedPath) => {
    emitHostEvent(deps.hostEventBus, deps.mainWindow, 'openclaw:cli-installed', { path: installedPath });
  }).then(() => {
    generateCompletionCache();
    installCompletionToProfile();
  }).catch((error) => {
    logger.warn('CLI auto-install failed:', error);
  });
}

async function autoStartGatewayIfEnabled(deps: {
  mainWindow: BrowserWindow;
  gatewayManager: GatewayManager;
  runtimeHostManager: RuntimeHostManager;
  hostEventBus: HostEventBus;
  settings: Pick<HostBootstrapSettings, 'gatewayAutoStart'>;
}): Promise<void> {
  if (!deps.settings.gatewayAutoStart) {
    logger.info('Gateway auto-start disabled in settings');
    return;
  }

  try {
    const response = await deps.runtimeHostManager.request<{
      success?: boolean;
      job?: RuntimeHostJobSnapshot;
    }>('POST', '/api/runtime-host/sync-provider-auth-bootstrap');
    const job = response.data?.job;
    if (!job?.id) {
      throw new Error('Runtime Host did not return a provider auth bootstrap job');
    }
    await waitForRuntimeHostJob(deps.runtimeHostManager, job.id, {
      timeoutMs: 120_000,
      intervalMs: 200,
    });
    logger.debug('Auto-starting Gateway...');
    await deps.gatewayManager.start();
    logger.info('Gateway auto-start succeeded');
  } catch (error) {
    logger.error('Gateway auto-start failed:', error);
    emitHostEvent(deps.hostEventBus, deps.mainWindow, 'gateway:error', { message: String(error) });
  }
}

export async function bootstrapMainApplication(deps: {
  gatewayManager: GatewayManager;
  runtimeHostManager: RuntimeHostManager;
  hostEventBus: HostEventBus;
  setMainWindow: (window: BrowserWindow | null) => void;
  getMainWindow: () => BrowserWindow | null;
}): Promise<{ mainWindow: BrowserWindow; hostApiServer: Server }> {
  logger.init();
  logger.info('=== MatchaClaw Application Starting ===');
  logger.debug(
    `Runtime: platform=${process.platform}/${process.arch}, electron=${process.versions.electron}, node=${process.versions.node}, packaged=${app.isPackaged}`,
  );

  if (!isE2EMode) {
    void warmupNetworkOptimization();
  } else {
    logger.info('E2E mode enabled: startup side effects are minimized');
  }

  createMenu();

  const mainWindow = createMainWindow();
  deps.setMainWindow(mainWindow);
  if (!isE2EMode) {
    createTray(mainWindow, {
      checkForUpdates: () => appUpdater.checkForUpdates(),
    });
  }

  await deps.runtimeHostManager.start();

  const hostBootstrapSettings = await loadHostBootstrapSettings();
  await applyProxySettings(hostBootstrapSettings);
  if (!isE2EMode) {
    await applyLaunchAtStartupSetting(hostBootstrapSettings.launchAtStartup);
  }

  registerGatewayControlUiSecurityHeaders();

  registerIpcHandlers(
    deps.gatewayManager,
    deps.getMainWindow,
    deps.runtimeHostManager,
  );
  const hostApiServer = await waitForHostApiServerListening(startHostApiServer({
    gatewayManager: deps.gatewayManager,
    eventBus: deps.hostEventBus,
    mainWindow,
    runtimeHost: deps.runtimeHostManager,
  }));

  loadMainWindowContent(mainWindow);

  if (!isE2EMode) {
    registerUpdateHandlers(appUpdater, mainWindow);
  }
  registerMainWindowLifecycle({
    mainWindow,
    clearMainWindowRef: () => deps.setMainWindow(null),
  });

  registerHostEventBridge({
    gatewayManager: deps.gatewayManager,
    runtimeHostManager: deps.runtimeHostManager,
    hostEventBus: deps.hostEventBus,
    getMainWindow: deps.getMainWindow,
  });

  if (!isE2EMode) {
    startNonBlockingBootstrapTasks({
      mainWindow,
      hostEventBus: deps.hostEventBus,
    });
  }

  if (!isE2EMode) {
    await autoStartGatewayIfEnabled({
      mainWindow,
      gatewayManager: deps.gatewayManager,
      runtimeHostManager: deps.runtimeHostManager,
      hostEventBus: deps.hostEventBus,
      settings: hostBootstrapSettings,
    });
  } else {
    logger.info('E2E mode: skip gateway auto-start');
  }

  return { mainWindow, hostApiServer };
}
