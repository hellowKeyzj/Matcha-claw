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
import { syncLaunchAtStartupSettingFromStore } from './launch-at-startup';
import { getSetting } from '../services/settings/settings-store';
import { ensureBuiltinSkillsInstalled, ensurePreinstalledSkillsInstalled } from '../services/skills/skill-config-service';
import { startHostApiServer } from '../api/server';
import type { HostEventBus } from '../api/event-bus';
import { ensureLicenseGateBootstrapped } from '../services/license/license-gate-service';
import type { RuntimeHostManager } from './runtime-host-manager';
import { emitHostEvent, registerHostEventBridge } from './host-event-bridge';
import { createMainWindow } from './main-window';
import { isQuitting } from './app-state';

const isE2EMode = process.env.CLAWX_E2E === '1';

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

function startNonBlockingBootstrapTasks(mainWindow: BrowserWindow): void {
  void ensureBuiltinSkillsInstalled().catch((error) => {
    logger.warn('Failed to install built-in skills:', error);
  });

  void ensurePreinstalledSkillsInstalled().catch((error) => {
    logger.warn('Failed to install preinstalled skills:', error);
  });

  void autoInstallCliIfNeeded((installedPath) => {
    mainWindow.webContents.send('openclaw:cli-installed', installedPath);
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
}): Promise<void> {
  const gatewayAutoStart = await getSetting('gatewayAutoStart');
  if (!gatewayAutoStart) {
    logger.info('Gateway auto-start disabled in settings');
    return;
  }

  try {
    await deps.runtimeHostManager.request('POST', '/api/runtime-host/sync-provider-auth-bootstrap');
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

  await applyProxySettings();
  if (!isE2EMode) {
    await syncLaunchAtStartupSettingFromStore();
  }

  createMenu();

  const mainWindow = createMainWindow();
  deps.setMainWindow(mainWindow);
  if (!isE2EMode) {
    createTray(mainWindow);
  }

  try {
    await deps.runtimeHostManager.start();
  } catch (error) {
    logger.warn('Runtime Host start failed, app will continue without plugin runtime:', error);
  }

  registerGatewayControlUiSecurityHeaders();

  registerIpcHandlers(
    deps.gatewayManager,
    mainWindow,
    deps.runtimeHostManager,
  );
  ensureLicenseGateBootstrapped();

  const hostApiServer = startHostApiServer({
    gatewayManager: deps.gatewayManager,
    eventBus: deps.hostEventBus,
    mainWindow,
    runtimeHost: deps.runtimeHostManager,
  });

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
    getMainWindow: () => mainWindow,
  });

  if (!isE2EMode) {
    startNonBlockingBootstrapTasks(mainWindow);
  }

  if (!isE2EMode) {
    await autoStartGatewayIfEnabled({
      mainWindow,
      gatewayManager: deps.gatewayManager,
      runtimeHostManager: deps.runtimeHostManager,
      hostEventBus: deps.hostEventBus,
    });
  } else {
    logger.info('E2E mode: skip gateway auto-start');
  }

  return { mainWindow, hostApiServer };
}
