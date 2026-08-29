import { app, BrowserWindow, nativeImage, nativeTheme, shell } from 'electron';
import { join } from 'path';
import { logger } from '../utils/logger';
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

const RENDERER_STARTUP_TRACE_FORWARDING_ENV = 'MATCHACLAW_FORWARD_RENDERER_STARTUP_TRACE';
const RENDERER_STARTUP_TRACE_PREFIX = '[startup-trace]';
const RENDERER_SESSION_TRACE_PREFIX = 'session-trace';
const RENDERER_STARTUP_TRACE_LIMIT = 500;

function shouldForwardRendererStartupTrace(): boolean {
  return !app.isPackaged && process.env[RENDERER_STARTUP_TRACE_FORWARDING_ENV] === '1';
}

function sanitizeRendererStartupTrace(message: string): string {
  return message
    .replace(/(?:[A-Za-z]:[\\/]|\/(?:Users|home|var|tmp|private)\/)[^\s"'<>)]*/g, '[path]')
    .replace(/(token|authorization|password|secret|api[-_ ]?key)(["'\s:=]+)[^\s"',}]+/gi, '$1$2[redacted]')
    .slice(0, RENDERER_STARTUP_TRACE_LIMIT);
}

function forwardRendererStartupTrace(win: BrowserWindow): void {
  if (!shouldForwardRendererStartupTrace()) return;
  win.webContents.on('console-message', (_event, _level, message) => {
    const isStartupTrace = message.includes(RENDERER_STARTUP_TRACE_PREFIX);
    const isSessionTrace = message.includes(`"prefix":"${RENDERER_SESSION_TRACE_PREFIX}"`);
    if (!isStartupTrace && !isSessionTrace) return;
    const tracePrefix = isStartupTrace ? RENDERER_STARTUP_TRACE_PREFIX : `[${RENDERER_SESSION_TRACE_PREFIX}]`;
    logger.info(`${tracePrefix} source=renderer-console message=${sanitizeRendererStartupTrace(message)}`);
  });
}

export function createMainWindow(options: { showOnReady?: boolean } = {}): BrowserWindow {
  const isMac = process.platform === 'darwin';
  const isWindows = process.platform === 'win32';
  const useCustomTitleBar = isWindows;

  const win = new BrowserWindow({
    width: 1600,
    height: 974,
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
    trafficLightPosition: isMac ? { x: 16, y: 16 } : undefined,
    frame: isMac || !useCustomTitleBar,
    show: false,
  });

  registerZoomShortcuts(win);
  forwardRendererStartupTrace(win);

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

  if (process.env.VITE_DEV_SERVER_URL) {
    void win.loadURL(process.env.VITE_DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: 'detach' });
    return;
  }

  void win.loadFile(join(__dirname, '../../dist/index.html'));
}
