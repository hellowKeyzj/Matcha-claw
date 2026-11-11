/**
 * Electron Main Process Entry
 */
import { app, BrowserWindow, dialog } from 'electron';
import { logger } from '../utils/logger';
import { isQuitting, setQuitting } from './lifecycle/state';
import { HostEventBus } from '../api/event-bus';
import { bootstrapMainApplication, type MainApplication } from './app-bootstrap';
import { DirectRuntimeHostDeliveryError } from './runtime-host-delivery/direct-host';
import { createMainWindow, loadMainWindowContent } from './desktop/main-window';
import { destroyTray } from './desktop/tray';
import {
  clearPendingSecondInstanceFocus,
  consumeMainWindowReady,
  createMainWindowFocusState,
  requestSecondInstanceFocus,
} from './desktop/main-window-focus';
import {
  createQuitLifecycleState,
  cancelQuitCleanup,
  completeQuitCleanup,
  markQuitCleanupCompleted,
  requestQuitLifecycleAction,
} from './lifecycle/quit';
import { createSignalQuitHandler } from './lifecycle/signals';
import { acquireProcessInstanceFileLock } from './lifecycle/instance-lock';
import { configureE2EWorldBootstrap } from '@electron/e2e-fixture-loader';
import { createGraphicsController } from './desktop/graphics';
import { registerGraphicsHandlers } from '../api/ipc/graphics-ipc';
import { registerAppPluginAssetScheme } from './app-plugins/assets';

registerAppPluginAssetScheme();

const WINDOWS_APP_USER_MODEL_ID = 'app.MatchaClaw.desktop';
const isE2EMode = process.env.MATCHACLAW_E2E === '1';
const requestedUserDataDir = process.env.MATCHACLAW_E2E_USER_DATA_DIR?.trim();

// Chromium's native smooth scrolling causes visible shimmer on Windows in
// Electron. Renderer-owned stable scrolling restores controlled wheel feel.
app.commandLine.appendSwitch('disable-smooth-scrolling');

// On Linux, set CHROME_DESKTOP so Chromium can find the correct .desktop file.
// On Wayland this maps the running window to matchaclaw.desktop (→ icon + app grouping);
// on X11 it supplements the StartupWMClass matching.
// Must be called before app.whenReady() / before any window is created.
if (process.platform === 'linux') {
  app.setDesktopName('matchaclaw.desktop');
}

const defaultUserDataDir = app.getPath('userData');
if (isE2EMode && requestedUserDataDir) {
  app.setPath('userData', requestedUserDataDir);
}

// Prevent multiple instances of the app from running simultaneously.
// Without this, two instances each spawn their own gateway process on the
// same port, then each treats the other's gateway as "orphaned" and kills
// it — creating an infinite kill/restart loop on Windows.
const gotElectronLock = isE2EMode ? true : app.requestSingleInstanceLock();
if (!gotElectronLock) {
  app.exit(0);
}
let releaseProcessInstanceFileLock: () => void = () => {};
let gotFileLock = true;
if (gotElectronLock && !isE2EMode) {
  try {
    const fileLock = acquireProcessInstanceFileLock({
      userDataDir: app.getPath('userData'),
      lockName: 'matchaclaw',
      force: true,
    });
    gotFileLock = fileLock.acquired;
    releaseProcessInstanceFileLock = fileLock.release;
    if (!fileLock.acquired) {
      const ownerDescriptor = fileLock.ownerPid
        ? `${fileLock.ownerFormat ?? 'legacy'} pid=${fileLock.ownerPid}`
        : fileLock.ownerFormat === 'unknown'
          ? 'unknown lock format/content'
          : 'unknown owner';
      logger.info(
        `[single-instance] process lock held by another instance, exiting duplicate process (${fileLock.lockPath}, ${ownerDescriptor})`,
      );
      app.exit(0);
    }
  } catch (error) {
    gotFileLock = false;
    logger.error('[single-instance] failed to acquire process file lock', error);
    app.exit(1);
  }
}
const gotTheLock = gotElectronLock && gotFileLock;

// Global references
let mainWindow: BrowserWindow | null = null;
let hostEventBus!: HostEventBus;
let application: MainApplication | null = null;
const mainWindowFocusState = createMainWindowFocusState();
const quitLifecycleState = createQuitLifecycleState();
const graphics = createGraphicsController({
  isShuttingDown: () => quitLifecycleState.cleanupStarted || isQuitting(),
});

async function handleBootstrapFailure(error: unknown): Promise<void> {
  if (isQuitting()) return;
  if (isE2EMode) {
    logger.error('Failed to bootstrap main application');
    return;
  }
  if (error instanceof DirectRuntimeHostDeliveryError && error.startupFailure === 'provider-migration-failed') {
    logger.error('Provider configuration migration failed during startup.');
    try {
      await dialog.showMessageBox({
        type: 'error',
        title: 'MatchaClaw',
        message: '模型配置恢复未完成，应用无法启动。',
        detail: '请检查磁盘空间和配置目录的读写权限后重启；仍无法启动请联系支持。请勿删除配置或备份。',
        buttons: ['退出'],
      });
    } finally {
      app.quit();
    }
    return;
  }
  logger.error('Failed to bootstrap main application:', error);
  app.quit();
}

function focusWindow(window: BrowserWindow): void {
  if (window.isDestroyed()) {
    return;
  }
  if (window.isMinimized()) {
    window.restore();
  }
  window.show();
  window.focus();
}

function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  clearPendingSecondInstanceFocus(mainWindowFocusState);
  focusWindow(mainWindow);
}

function bindPendingSecondInstanceFocus(window: BrowserWindow): void {
  const applyPendingFocus = () => {
    if (mainWindow !== window || window.isDestroyed()) {
      return;
    }
    if (consumeMainWindowReady(mainWindowFocusState) === 'focus') {
      focusWindow(window);
    }
  };

  if (window.isVisible()) {
    applyPendingFocus();
    return;
  }

  window.once('ready-to-show', applyPendingFocus);
}

// When a second instance is launched, focus the existing window instead.
app.on('second-instance', () => {
  const focusRequest = requestSecondInstanceFocus(
    mainWindowFocusState,
    Boolean(mainWindow && !mainWindow.isDestroyed()),
  );
  if (focusRequest === 'focus-now') {
    focusMainWindow();
  }
});

if (gotTheLock) {
  const requestQuitOnSignal = createSignalQuitHandler({
    logInfo: (message) => logger.info(message),
    requestQuit: () => app.quit(),
  });

  process.on('exit', () => {
    releaseProcessInstanceFileLock();
  });

  process.once('SIGINT', () => requestQuitOnSignal('SIGINT'));
  process.once('SIGTERM', () => requestQuitOnSignal('SIGTERM'));

  app.on('will-quit', () => {
    releaseProcessInstanceFileLock();
  });

  if (process.platform === 'win32' && app.isPackaged) {
    app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID);
  }

  hostEventBus = new HostEventBus();
  const stopGraphicsIpc = registerGraphicsHandlers(graphics, () => mainWindow);
  app.once('will-quit', () => {
    stopGraphicsIpc();
    graphics.dispose();
  });

  // Application lifecycle
  app.whenReady().then(async () => {
    if (isQuitting() || quitLifecycleState.cleanupStarted) return;
    if (isE2EMode) await configureE2EWorldBootstrap(defaultUserDataDir);
    if (isQuitting() || quitLifecycleState.cleanupStarted) return;
    application = bootstrapMainApplication({
      hostEventBus,
      setMainWindow: (window) => {
        mainWindow = window;
        if (window && !window.isDestroyed()) {
          bindPendingSecondInstanceFocus(window);
        }
      },
      getMainWindow: () => mainWindow,
    });
    mainWindow = application.mainWindow;
    bindPendingSecondInstanceFocus(application.mainWindow);
    void application.ready.catch(handleBootstrapFailure);

    // Register activate handler AFTER app is ready to prevent
    // "Cannot create BrowserWindow before app is ready" on macOS.
    app.on('activate', () => {
      if (isQuitting()) return;
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          bindPendingSecondInstanceFocus(mainWindow);
          loadMainWindowContent(mainWindow);
        }
      } else if (mainWindow && !mainWindow.isDestroyed()) {
        // On macOS, clicking the dock icon should show the window if it's hidden
        focusMainWindow();
      }
    });
  }).catch(handleBootstrapFailure);

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('before-quit', async (event) => {
    const action = requestQuitLifecycleAction(quitLifecycleState);

    if (action === 'allow-quit') {
      return;
    }
    event.preventDefault();

    if (action === 'cleanup-in-progress') {
      logger.debug('Quit requested while cleanup already in progress');
      return;
    }

    try {
      await application?.prepareQuit();
    } catch (error) {
      application?.cancelQuit();
      cancelQuitCleanup(quitLifecycleState);
      setQuitting(false);
      logger.warn('Quit cancelled because browser data could not be saved:', error);
      focusMainWindow();
      hostEventBus.emit('iab:event', { type: 'quit-blocked' });
      graphics.cancelRestart('quit-cancelled');
      return;
    }

    if (!await graphics.commitRestart()) {
      application?.cancelQuit();
      cancelQuitCleanup(quitLifecycleState);
      focusMainWindow();
      return;
    }

    setQuitting();
    hostEventBus.closeAll();
    destroyTray();
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.destroy();
    }

    const result = await completeQuitCleanup(
      () => application?.close() ?? Promise.resolve(),
      () => application?.forceClose() ?? Promise.resolve(),
      () => application?.readShutdownStage() ?? 'bootstrap',
    );
    markQuitCleanupCompleted(quitLifecycleState);
    graphics.relaunchAfterQuit(result);
    if (result.outcome === 'graceful') app.quit();
    else app.exit(result.outcome === 'forced' ? 1 : 2);
  });
}

// Export for testing
export { mainWindow };
