import { app, BrowserWindow, nativeImage, nativeTheme, shell } from 'electron';
import { join } from 'path';
import { logger } from '../utils/logger';
import { isTraceEnabled, startupTrace, traceDebug } from '../utils/trace-logger';
import { getMacTrafficLightPosition } from './traffic-light-layout';
import { getWindowThemeBackgroundColor } from './window';
import { registerZoomShortcuts } from './zoom-shortcuts';

function getIconsDir(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'resources', 'icons');
  }
  return join(__dirname, '../../resources/icons');
}

function getAppIcon(): Electron.NativeImage | undefined {
  if (process.platform === 'darwin') return undefined;

  const iconsDir = getIconsDir();
  const iconPath =
    process.platform === 'win32'
      ? join(iconsDir, 'icon.ico')
      : join(iconsDir, 'icon.png');
  const icon = nativeImage.createFromPath(iconPath);
  return icon.isEmpty() ? undefined : icon;
}

const RENDERER_STARTUP_TRACE_PREFIX = '[startup-trace]';
const RENDERER_SESSION_TRACE_PREFIX = 'session-trace';
const RENDERER_STARTUP_TRACE_LIMIT = 500;
const RENDERER_SESSION_TRACE_LIMIT = 4 * 1024 * 1024;

function sanitizeRendererStartupTrace(message: string): string {
  return message
    .replace(/(?:[A-Za-z]:[\\/]|\/(?:Users|home|var|tmp|private)\/)[^\s"'<>)]*/g, '[path]')
    .replace(/(token|authorization|password|secret|api[-_ ]?key)(["'\s:=]+)[^\s"',}]+/gi, '$1$2[redacted]')
    .slice(0, RENDERER_STARTUP_TRACE_LIMIT);
}

function forwardRendererStartupTrace(win: BrowserWindow): void {
  if (!isTraceEnabled()) return;
  win.webContents.on('console-message', (_event, _level, message) => {
    if (!isTraceEnabled()) return;
    const isSessionTrace = message.includes(`"prefix":"${RENDERER_SESSION_TRACE_PREFIX}"`);
    const isStartupTrace = !isSessionTrace && message.includes(RENDERER_STARTUP_TRACE_PREFIX);
    if (!isStartupTrace && !isSessionTrace) return;
    if (isSessionTrace) {
      if (message.length > RENDERER_SESSION_TRACE_LIMIT) {
        logger.warn(`[${RENDERER_SESSION_TRACE_PREFIX}] source=renderer-console dropped=oversize length=${message.length}`);
        return;
      }
      // Session traces contain only diagnostic summaries; preserve the complete assembly record.
      traceDebug(() => `[${RENDERER_SESSION_TRACE_PREFIX}] source=renderer-console message=${message
        .replace(/(?:[A-Za-z]:[\\/]|\/(?:Users|home|var|tmp|private)\/)[^\s"'<>)]*/g, '[path]')
        .replace(/(token|authorization|password|secret|api[-_ ]?key)(["'\s:=]+)[^\s"',}]+/gi, '$1$2[redacted]')}`);
    } else {
      traceDebug(() => `${RENDERER_STARTUP_TRACE_PREFIX} source=renderer-console message=${sanitizeRendererStartupTrace(message)}`);
    }
  });
}

export function createMainWindow(options: { showOnReady?: boolean } = {}): BrowserWindow {
  const startedAt = isTraceEnabled() ? performance.now() : 0;
  startupTrace('main-window', 'create.start');
  const isMac = process.platform === 'darwin';
  const isWindows = process.platform === 'win32';
  const useCustomTitleBar = isWindows;

  const win = new BrowserWindow({
    width: 1286,
    height: 824,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: getWindowThemeBackgroundColor(nativeTheme.shouldUseDarkColors ? 'dark' : 'light'),
    icon: getAppIcon(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webviewTag: true,
    },
    titleBarStyle: isMac ? 'hiddenInset' : useCustomTitleBar ? 'hidden' : 'default',
    trafficLightPosition: isMac ? getMacTrafficLightPosition(false) : undefined,
    frame: isMac || !useCustomTitleBar,
    show: false,
  });

  registerZoomShortcuts(win);
  forwardRendererStartupTrace(win);
  startupTrace('main-window', 'create.end', () => ({
    windowId: win.id, elapsedMs: Math.round(performance.now() - startedAt),
  }));
  if (isTraceEnabled()) {
    const trace = (phase: string, detail?: () => Record<string, unknown>) => {
      startupTrace('main-window', phase, () => ({
        windowId: win.id, elapsedMs: Math.round(performance.now() - startedAt), ...detail?.(),
      }));
    };
    win.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame) trace('navigation.start', () => ({ isInPlace }));
    });
    win.webContents.on('did-navigate', () => trace('navigation.committed'));
    win.webContents.on('did-start-loading', () => trace('loading.start'));
    win.webContents.on('dom-ready', () => trace('dom.ready'));
    win.webContents.on('did-finish-load', () => trace('load.finished'));
    win.webContents.on('did-stop-loading', () => trace('loading.end'));
    win.webContents.on('did-fail-provisional-load', (_event, errorCode, _description, _url, isMainFrame) => {
      if (isMainFrame) trace('navigation.error', () => ({ errorCode }));
    });
    win.webContents.on('did-fail-load', (_event, errorCode, _description, _url, isMainFrame) => {
      if (isMainFrame) trace('load.error', () => ({ errorCode }));
    });
    win.webContents.on('render-process-gone', (_event, details) => {
      trace('renderer.gone', () => ({ reason: details.reason, exitCode: details.exitCode }));
    });
    win.once('ready-to-show', () => trace('ready-to-show'));
    win.on('show', () => trace('shown'));
    win.on('unresponsive', () => trace('renderer.unresponsive'));
    win.on('responsive', () => trace('renderer.responsive'));
  }

  if (options.showOnReady ?? true) {
    win.once('ready-to-show', () => {
      win.show();
      win.focus();
    });
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        void shell.openExternal(url);
      } else {
        logger.warn(`Blocked openExternal for disallowed protocol: ${parsed.protocol}`);
      }
    } catch {
      logger.warn(`Blocked openExternal for malformed URL: ${url}`);
    }
    return { action: 'deny' };
  });

  return win;
}

export function loadMainWindowContent(win: BrowserWindow): void {
  if (win.isDestroyed() || win.webContents.getURL()) {
    return;
  }

  startupTrace('main-window', 'load.request', () => ({
    windowId: win.id, mode: process.env.VITE_DEV_SERVER_URL ? 'dev-server' : 'file',
  }));
  if (process.env.VITE_DEV_SERVER_URL) {
    void win.loadURL(process.env.VITE_DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: 'detach' });
    return;
  }

  void win.loadFile(join(__dirname, '../../dist/index.html'));
}
