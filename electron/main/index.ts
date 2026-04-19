/**
 * Electron Main Process Entry
 */
import { app, BrowserWindow } from 'electron';
import type { Server } from 'node:http';
import { GatewayManager } from '../gateway/manager';
import { logger } from '../utils/logger';
import { setQuitting } from './app-state';
import { HostEventBus } from '../api/event-bus';
import { createRuntimeHostManager, type RuntimeHostManager } from './runtime-host-manager';
import { bootstrapMainApplication } from './app-bootstrap';
import { createMainWindow, loadMainWindowContent } from './main-window';
import {
  clearPendingSecondInstanceFocus,
  consumeMainWindowReady,
  createMainWindowFocusState,
  requestSecondInstanceFocus,
} from './main-window-focus';
import {
  createQuitLifecycleState,
  markQuitCleanupCompleted,
  requestQuitLifecycleAction,
} from './quit-lifecycle';
import { createSignalQuitHandler } from './signal-quit';
import { acquireProcessInstanceFileLock } from './process-instance-lock';

const WINDOWS_APP_USER_MODEL_ID = 'app.clawx.desktop';
const isE2EMode = process.env.CLAWX_E2E === '1';
const requestedUserDataDir = process.env.CLAWX_E2E_USER_DATA_DIR?.trim();

// Disable GPU hardware acceleration globally for maximum stability across
// all GPU configurations (no GPU, integrated, discrete).
//
// Rationale (following VS Code's philosophy):
// - Page/file loading is async data fetching — zero GPU dependency.
// - The original per-platform GPU branching was added to avoid CPU rendering
//   competing with sync I/O on Windows, but all file I/O is now async
//   (fs/promises), so that concern no longer applies.
// - Software rendering is deterministic across all hardware; GPU compositing
//   behaviour varies between vendors (Intel, AMD, NVIDIA, Apple Silicon) and
//   driver versions, making it the #1 source of rendering bugs in Electron.
//
// Users who want GPU acceleration can pass `--enable-gpu` on the CLI or
// set `"disable-hardware-acceleration": false` in the app config (future).
app.disableHardwareAcceleration();

// On Linux, set CHROME_DESKTOP so Chromium can find the correct .desktop file.
// On Wayland this maps the running window to clawx.desktop (→ icon + app grouping);
// on X11 it supplements the StartupWMClass matching.
// Must be called before app.whenReady() / before any window is created.
if (process.platform === 'linux') {
  app.setDesktopName('clawx.desktop');
}

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
      lockName: 'clawx',
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
    logger.warn('[single-instance] failed to acquire process file lock, fallback to electron lock only', error);
  }
}
const gotTheLock = gotElectronLock && gotFileLock;

// Global references
let mainWindow: BrowserWindow | null = null;
let gatewayManager!: GatewayManager;
let hostEventBus!: HostEventBus;
let runtimeHostManager!: RuntimeHostManager;
let hostApiServer: Server | null = null;
const mainWindowFocusState = createMainWindowFocusState();
const quitLifecycleState = createQuitLifecycleState();

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

  if (process.platform === 'win32') {
    app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID);
  }

  gatewayManager = new GatewayManager();
  hostEventBus = new HostEventBus();
  runtimeHostManager = createRuntimeHostManager({
    gatewayManager,
  });

  // Application lifecycle
  app.whenReady().then(() => {
    void bootstrapMainApplication({
      gatewayManager,
      runtimeHostManager,
      hostEventBus,
      setMainWindow: (window) => {
        mainWindow = window;
        if (window && !window.isDestroyed()) {
          bindPendingSecondInstanceFocus(window);
        }
      },
      getMainWindow: () => mainWindow,
    }).then((result) => {
      mainWindow = result.mainWindow;
      bindPendingSecondInstanceFocus(result.mainWindow);
      hostApiServer = result.hostApiServer;
    }).catch((error) => {
      logger.error('Failed to bootstrap main application:', error);
      app.quit();
    });

    // Register activate handler AFTER app is ready to prevent
    // "Cannot create BrowserWindow before app is ready" on macOS.
    app.on('activate', () => {
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
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('before-quit', (event) => {
    setQuitting();
    const action = requestQuitLifecycleAction(quitLifecycleState);

    if (action === 'allow-quit') {
      return;
    }
    event.preventDefault();

    if (action === 'cleanup-in-progress') {
      logger.debug('Quit requested while cleanup already in progress');
      return;
    }

    hostEventBus.closeAll();
    hostApiServer?.close();

    const stopPromise = Promise.allSettled([
      runtimeHostManager.stop().catch((err) => {
        logger.warn('runtimeHostManager.stop() error during quit:', err);
      }),
      gatewayManager.stop().catch((err) => {
        logger.warn('gatewayManager.stop() error during quit:', err);
      }),
    ]).then(() => undefined);

    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), 5000);
    });

    void Promise.race([stopPromise.then(() => 'stopped' as const), timeoutPromise]).then((result) => {
      const finishQuit = () => {
        markQuitCleanupCompleted(quitLifecycleState);
        app.quit();
      };
      if (result !== 'timeout') {
        finishQuit();
        return;
      }
      void gatewayManager.forceTerminateOwnedProcessForQuit().catch((err) => {
        logger.warn('gatewayManager.forceTerminateOwnedProcessForQuit() failed during quit:', err);
      }).finally(finishQuit);
    });
  });
}

// Export for testing
export { mainWindow, gatewayManager };
