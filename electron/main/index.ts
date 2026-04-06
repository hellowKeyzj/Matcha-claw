/**
 * Electron Main Process Entry
 */
import { app, BrowserWindow } from 'electron';
import type { Server } from 'node:http';
import { GatewayManager } from '../gateway/manager';
import { logger } from '../utils/logger';
import { setQuitting } from './app-state';
import { HostEventBus } from '../api/event-bus';
import { createRuntimeHostManager } from './runtime-host-manager';
import { bootstrapMainApplication } from './app-bootstrap';
import { createMainWindow } from './main-window';

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

// Prevent multiple instances of the app from running simultaneously.
// Without this, two instances each spawn their own gateway process on the
// same port, then each treats the other's gateway as "orphaned" and kills
// it — creating an infinite kill/restart loop on Windows.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

// Global references
let mainWindow: BrowserWindow | null = null;
const gatewayManager = new GatewayManager();
const hostEventBus = new HostEventBus();
const runtimeHostManager = createRuntimeHostManager({
  gatewayManager,
});
let hostApiServer: Server | null = null;

// When a second instance is launched, focus the existing window instead.
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// Application lifecycle
app.whenReady().then(() => {
  void bootstrapMainApplication({
    gatewayManager,
    runtimeHostManager,
    hostEventBus,
    setMainWindow: (window) => {
      mainWindow = window;
    },
  }).then((result) => {
    mainWindow = result.mainWindow;
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
    } else if (mainWindow && !mainWindow.isDestroyed()) {
      // On macOS, clicking the dock icon should show the window if it's hidden
      mainWindow.show();
      mainWindow.focus();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  setQuitting();
  hostEventBus.closeAll();
  hostApiServer?.close();
  void runtimeHostManager.stop().catch((err) => {
    logger.warn('runtimeHostManager.stop() error during quit:', err);
  });
  // Fire-and-forget: do not await gatewayManager.stop() here.
  // Awaiting inside before-quit can stall Electron's quit sequence.
  void gatewayManager.stop().catch((err) => {
    logger.warn('gatewayManager.stop() error during quit:', err);
  });
});

// Export for testing
export { mainWindow, gatewayManager };


