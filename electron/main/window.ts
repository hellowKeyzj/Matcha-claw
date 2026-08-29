/**
 * Window Management Utilities
 * Handles window state persistence and multi-window management
 */
import { BrowserWindow, screen, type Rectangle } from 'electron';

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized: boolean;
}

// Lazy-load electron-store (ESM module)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let windowStateStore: any = null;
interface WindowRightDockState {
  width: number;
  baseX: number;
  baseWidth: number;
  dockedX: number;
  dockedWidth: number;
}

interface WindowRightDockOptions {
  resizeWindow?: boolean;
  currentDockWidth?: number;
}

const rightDockStateByWindow = new WeakMap<BrowserWindow, WindowRightDockState>();

export type WindowThemeBackground = 'light' | 'dark';

const WINDOW_THEME_BACKGROUND_COLORS: Record<WindowThemeBackground, string> = {
  light: '#ffffff',
  dark: '#1e1e20',
};

export function getWindowThemeBackgroundColor(theme: WindowThemeBackground): string {
  return WINDOW_THEME_BACKGROUND_COLORS[theme];
}

function getWindowRightDockState(win: BrowserWindow): WindowRightDockState | null {
  return rightDockStateByWindow.get(win) ?? null;
}

function setTrackedWindowRightDockState(win: BrowserWindow, state: WindowRightDockState | null): void {
  if (state && state.width > 0) {
    rightDockStateByWindow.set(win, state);
  } else {
    rightDockStateByWindow.delete(win);
  }
}

function normalizeRightDockWidth(width: number): number {
  return Number.isFinite(width) ? Math.max(0, Math.round(width)) : 0;
}

function reconcileWindowRightDockState(win: BrowserWindow, bounds: Rectangle = win.getBounds()): WindowRightDockState | null {
  const state = getWindowRightDockState(win);
  if (!state) {
    return null;
  }
  if (bounds.x === state.dockedX && bounds.width === state.dockedWidth) {
    return state;
  }
  const nextState = {
    ...state,
    baseX: bounds.x,
    baseWidth: Math.max(1, bounds.width - state.width),
    dockedX: bounds.x,
    dockedWidth: bounds.width,
  };
  setTrackedWindowRightDockState(win, nextState);
  return nextState;
}

function createWindowRightDockState(
  width: number,
  baseX: number,
  baseWidth: number,
  dockedX: number,
  dockedWidth: number,
): WindowRightDockState {
  return {
    width,
    baseX,
    baseWidth,
    dockedX,
    dockedWidth,
  };
}

function getPersistableBounds(win: BrowserWindow): Rectangle {
  const bounds = win.getBounds();
  const rightDockState = reconcileWindowRightDockState(win, win.getContentBounds());
  if (!rightDockState) {
    return bounds;
  }
  return {
    ...bounds,
    x: rightDockState.baseX,
    width: Math.max(1, bounds.width - rightDockState.width),
  };
}

async function getStore() {
  if (!windowStateStore) {
    const Store = (await import('electron-store')).default;
    windowStateStore = new Store<{ windowState: WindowState }>({
      name: 'window-state',
      defaults: {
        windowState: {
          width: 1280,
          height: 800,
          isMaximized: false,
        },
      },
    });
  }
  return windowStateStore;
}

/**
 * Get saved window state with bounds validation
 */
export async function getWindowState(): Promise<WindowState> {
  const store = await getStore();
  const state = store.get('windowState');

  // Validate that the window is visible on a screen
  if (state.x !== undefined && state.y !== undefined) {
    const displays = screen.getAllDisplays();
    const isVisible = displays.some((display) => {
      const { x, y, width, height } = display.bounds;
      return (
        state.x! >= x &&
        state.x! < x + width &&
        state.y! >= y &&
        state.y! < y + height
      );
    });

    if (!isVisible) {
      // Reset position if not visible
      delete state.x;
      delete state.y;
    }
  }

  return state;
}

export function setWindowRightDockWidth(
  win: BrowserWindow,
  width: number,
  options: WindowRightDockOptions = {},
): { appliedWidth: number } {
  const requestedWidth = normalizeRightDockWidth(width);
  const hasCurrentDockWidth = options.currentDockWidth !== undefined && Number.isFinite(options.currentDockWidth);
  if (win.isMaximized() || win.isFullScreen()) {
    if (requestedWidth === 0) {
      setTrackedWindowRightDockState(win, null);
      return { appliedWidth: 0 };
    }
    return { appliedWidth: hasCurrentDockWidth ? normalizeRightDockWidth(options.currentDockWidth ?? 0) : getWindowRightDockState(win)?.width ?? 0 };
  }

  const bounds = win.getContentBounds();
  const trackedState = getWindowRightDockState(win);
  const previousState = trackedState && bounds.x === trackedState.dockedX && bounds.width === trackedState.dockedWidth
    ? trackedState
    : reconcileWindowRightDockState(win, bounds);
  const previousWidth = hasCurrentDockWidth
    ? normalizeRightDockWidth(options.currentDockWidth ?? 0)
    : previousState?.width ?? 0;
  const currentBoundsAreBase = hasCurrentDockWidth && previousWidth === 0;
  const baseX = currentBoundsAreBase
    ? bounds.x
    : previousState?.baseX ?? bounds.x;
  const baseWidth = currentBoundsAreBase
    ? bounds.width
    : previousState?.baseWidth ?? Math.max(1, bounds.width - previousWidth);

  if (requestedWidth > 0 && options.resizeWindow === false) {
    const appliedWidth = Math.min(requestedWidth, Math.max(0, bounds.width - 1));
    setTrackedWindowRightDockState(
      win,
      appliedWidth > 0
        ? createWindowRightDockState(
          appliedWidth,
          previousState && bounds.x === previousState.dockedX && bounds.width === previousState.dockedWidth
            ? previousState.baseX
            : bounds.x,
          Math.max(1, bounds.width - appliedWidth),
          bounds.x,
          bounds.width,
        )
        : null,
    );
    return { appliedWidth };
  }

  const workArea = screen.getDisplayMatching(bounds).workArea;
  const workAreaRight = workArea.x + workArea.width;
  const appliedWidth = Math.min(requestedWidth, Math.max(0, workArea.width - baseWidth));
  const nextWidth = baseWidth + appliedWidth;
  const nextX = appliedWidth > 0
    ? Math.max(workArea.x, Math.min(baseX, workAreaRight - nextWidth))
    : baseX;
  const nextState = appliedWidth > 0
    ? createWindowRightDockState(appliedWidth, baseX, baseWidth, nextX, nextWidth)
    : null;

  if (nextX === bounds.x && nextWidth === bounds.width) {
    setTrackedWindowRightDockState(win, nextState);
    return { appliedWidth };
  }

  setTrackedWindowRightDockState(win, nextState);
  try {
    win.setContentBounds({ ...bounds, x: nextX, width: nextWidth });
  } catch (error) {
    setTrackedWindowRightDockState(win, previousState);
    throw error;
  }
  return { appliedWidth };
}

/**
 * Save window state
 */
export async function saveWindowState(win: BrowserWindow): Promise<void> {
  const store = await getStore();
  const isMaximized = win.isMaximized();
  const isFullScreen = win.isFullScreen();

  if (!isMaximized && !isFullScreen) {
    const bounds = getPersistableBounds(win);
    store.set('windowState', {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      isMaximized,
    });
  } else {
    store.set('windowState.isMaximized', isMaximized);
  }
}

/**
 * Track window state changes
 */
export function trackWindowState(win: BrowserWindow): void {
  // Save state on window events
  ['resize', 'move', 'close'].forEach((event) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    win.on(event as any, () => saveWindowState(win));
  });
}
