/**
 * Electron Main Process Entry
 */
import { app, BrowserWindow } from 'electron';
import type { Server } from 'node:http';
import { GatewayManager } from './process-runtime/openclaw-gateway/manager';
import { logger } from '../utils/logger';
import { setQuitting } from './app-state';
import { HostEventBus } from '../api/event-bus';
import { createRuntimeHostManager, type RuntimeHostManager } from './runtime-host-manager';
import {
  createMatchaAgentAppServerProcessManager,
  type MatchaAgentAppServerProcessManager,
} from './process-runtime/matcha-agent-app-server-process-manager';
import { createOpenClawGatewayProcessManager } from './process-runtime/openclaw-gateway-process-manager';
import type { LocalProcessReadiness } from './process-runtime/contracts';
import { LocalProcessRegistry } from './process-runtime/process-registry';
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
import { waitForGatewayControlReady } from './gateway-control-ready-probe';

const WINDOWS_APP_USER_MODEL_ID = 'app.matchaclaw.desktop';
const isE2EMode = process.env.MATCHACLAW_E2E === '1';
const requestedUserDataDir = process.env.MATCHACLAW_E2E_USER_DATA_DIR?.trim();
const localProcessRegistry = new LocalProcessRegistry();

async function checkRuntimeHostReadiness(manager: RuntimeHostManager): Promise<LocalProcessReadiness> {
  const health = await manager.checkHealth();
  if (health.ok) {
    return { status: 'ready', detail: health.lifecycle };
  }
  if (health.lifecycle === 'starting' || health.lifecycle === 'restarting') {
    return { status: 'not-ready', detail: health.lifecycle };
  }
  return { status: 'error', error: health.error ?? `Runtime Host state is ${health.lifecycle}` };
}

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
let gatewayManager!: GatewayManager;
let hostEventBus!: HostEventBus;
let matchaAgentAppServerManager!: MatchaAgentAppServerProcessManager;
let runtimeHostManager!: RuntimeHostManager;
let hostApiServer: Server | null = null;
const mainWindowFocusState = createMainWindowFocusState();
const quitLifecycleState = createQuitLifecycleState();

function isQuitCleanupStarted(): boolean {
  return quitLifecycleState.cleanupStarted;
}

function guardProcessStartDuringQuit<TManager extends {
  readonly start: () => Promise<void>;
  readonly restart: () => Promise<void>;
}>(displayName: string, manager: TManager): TManager {
  return {
    ...manager,
    async start() {
      if (isQuitCleanupStarted()) {
        logger.debug(`[quit] Skip ${displayName} start because quit cleanup is in progress`);
        return;
      }
      await manager.start();
    },
    async restart() {
      if (isQuitCleanupStarted()) {
        logger.debug(`[quit] Skip ${displayName} restart because quit cleanup is in progress`);
        return;
      }
      await manager.restart();
    },
  };
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

  if (process.platform === 'win32') {
    app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID);
  }

  gatewayManager = new GatewayManager();
  hostEventBus = new HostEventBus();
  const rawGatewayProcessRunner = createOpenClawGatewayProcessManager({
    gatewayManager,
    logger,
  });
  const gatewayProcessController = guardProcessStartDuringQuit(
    'OpenClaw gateway',
    rawGatewayProcessRunner,
  );
  gatewayManager.setProcessController(gatewayProcessController);
  const rawMatchaAgentAppServerManager = createMatchaAgentAppServerProcessManager({
    logger,
  });
  matchaAgentAppServerManager = guardProcessStartDuringQuit('matcha-agent app-server', rawMatchaAgentAppServerManager);
  const rawRuntimeHostManager = createRuntimeHostManager({
    gatewayManager,
    matchaAgentAppServerManager,
  });
  runtimeHostManager = guardProcessStartDuringQuit('runtime-host', rawRuntimeHostManager);
  localProcessRegistry.registerRunnerLike({
    id: 'runtime-host',
    displayName: 'runtime-host',
    runner: {
      start: () => runtimeHostManager.start(),
      stop: () => runtimeHostManager.stop(),
      restart: () => runtimeHostManager.restart(),
      forceTerminate: () => runtimeHostManager.forceTerminate(),
      checkReadiness: () => checkRuntimeHostReadiness(runtimeHostManager),
      getState: () => runtimeHostManager.getState(),
      onStateChange: (handler) => runtimeHostManager.onStateChange(handler),
    },
  });
  localProcessRegistry.registerRunnerLike({
    id: 'openclaw-gateway',
    displayName: 'OpenClaw gateway',
    runner: {
      start: () => gatewayManager.start(),
      stop: () => gatewayManager.stop(),
      restart: () => gatewayManager.restart().then(() => undefined),
      forceTerminate: () => rawGatewayProcessRunner.forceTerminate(),
      checkReadiness: () => rawGatewayProcessRunner.checkReadiness(),
      getState: () => rawGatewayProcessRunner.getState(),
      onStateChange: (handler) => rawGatewayProcessRunner.onStateChange(handler),
    },
  });
  localProcessRegistry.registerRunnerLike({
    id: 'matcha-agent-app-server',
    displayName: 'matcha-agent app-server',
    runner: matchaAgentAppServerManager,
  });
  gatewayManager.setRuntimeHostManager(runtimeHostManager);
  gatewayManager.setControlReadyProbe(async (timeoutMs, port, externalToken) => {
    await waitForGatewayControlReady({
      runtimeHostManager,
      nowMs: () => Date.now(),
      delay: async (ms) => {
        await new Promise((resolve) => setTimeout(resolve, ms));
      },
    }, timeoutMs, port, externalToken);
  });

  // Application lifecycle
  app.whenReady().then(() => {
    void bootstrapMainApplication({
      gatewayManager,
      matchaAgentAppServerManager,
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

    const stopPromise = localProcessRegistry.stopAll()
      .then(() => 'stopped' as const)
      .catch((error) => {
        logger.warn('Failed to stop one or more owned processes during quit:', error);
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
            ? 'Quit cleanup timed out; force-terminating all registered owned processes'
            : 'Quit cleanup failed; force-terminating all registered owned processes',
        );
        try {
          await localProcessRegistry.forceTerminateAll();
        } catch (error) {
          logger.warn('Failed to force-terminate one or more owned processes during quit:', error);
        }
      }
      markQuitCleanupCompleted(quitLifecycleState);
      app.quit();
    });
  });
}

// Export for testing
export { mainWindow, gatewayManager };
