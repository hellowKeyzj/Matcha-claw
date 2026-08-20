/**
 * Electron Main Process Entry
 */
import { app, BrowserWindow } from 'electron';
import { logger } from '../utils/logger';
import { setQuitting } from './app-state';
import { HostEventBus } from '../api/event-bus';
import type { RuntimeHostLifecycleOwner } from './runtime-host-delivery/lifecycle-owner';
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

const WINDOWS_APP_USER_MODEL_ID = 'app.matchaclaw.desktop';
const isE2EMode = process.env.MATCHACLAW_E2E === '1';
const requestedUserDataDir = process.env.MATCHACLAW_E2E_USER_DATA_DIR?.trim();

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
// On Wayland this maps the running window to matchaclaw.desktop (→ icon + app grouping);
// on X11 it supplements the StartupWMClass matching.
// Must be called before app.whenReady() / before any window is created.
if (process.platform === 'linux') {
  app.setDesktopName('matchaclaw.desktop');
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
    logger.warn('[single-instance] failed to acquire process file lock, fallback to electron lock only', error);
  }
}
const gotTheLock = gotElectronLock && gotFileLock;

// Global references
let mainWindow: BrowserWindow | null = null;
let hostEventBus!: HostEventBus;
let directRuntimeHost: RuntimeHostLifecycleOwner | null = null;
let closeRuntimeHostDelivery: (() => Promise<void>) | null = null;
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

  if (process.platform === 'win32' && app.isPackaged) {
    app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID);
  }

  hostEventBus = new HostEventBus();

  // Application lifecycle
  app.whenReady().then(() => {
    void bootstrapMainApplication({
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
      directRuntimeHost = result.directRuntimeHost;
      closeRuntimeHostDelivery = result.closeRuntimeHostDelivery;
    }).catch((error) => {
      if (isE2EMode) {
        logger.error('Failed to bootstrap main application');
        return;
      }
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

    const runtimeHost = directRuntimeHost;
    if (!runtimeHost) {
      markQuitCleanupCompleted(quitLifecycleState);
      app.quit();
      return;
    }
    const stopPromise = runtimeHost.stop()
      .then(() => 'stopped' as const)
      .catch((error) => {
        logger.warn('Failed to stop Direct Runtime Host during quit:', error);
        return 'stop-failed' as const;
      });

    let quitCleanupTimeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      quitCleanupTimeout = setTimeout(() => resolve('timeout'), 5000);
      quitCleanupTimeout.unref?.();
    });

    void Promise.race([stopPromise, timeoutPromise]).then(async (result) => {
      if (quitCleanupTimeout) {
        clearTimeout(quitCleanupTimeout);
      }
      if (result !== 'stopped') {
        logger.warn(
          result === 'timeout'
            ? 'Direct Runtime Host stop timed out; force-killing it'
            : 'Direct Runtime Host stop failed; force-killing it',
        );
        try {
          await runtimeHost.forceKill();
        } catch (error) {
          logger.warn('Failed to force-kill Direct Runtime Host during quit:', error);
        }
      }
      await closeRuntimeHostDelivery?.().catch((error) => {
        logger.warn('Failed to close Runtime Host delivery during quit:', error);
      });
      closeRuntimeHostDelivery = null;
      markQuitCleanupCompleted(quitLifecycleState);
      app.quit();
    });
  });
}

// Export for testing
export { mainWindow };
