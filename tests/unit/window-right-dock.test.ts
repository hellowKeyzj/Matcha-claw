import { beforeEach, describe, expect, it, vi } from 'vitest';
import { saveWindowState, setWindowRightDockWidth } from '../../electron/main/window';

const storeSetMock = vi.hoisted(() => vi.fn());
const screenMock = vi.hoisted(() => ({
  getDisplayMatching: vi.fn(() => ({
    workArea: {
      x: 0,
      y: 0,
      width: 2200,
      height: 1200,
    },
  })),
}));

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  screen: screenMock,
}));

vi.mock('electron-store', () => ({
  default: vi.fn(function Store() {
    return {
      get: vi.fn(),
      set: storeSetMock,
    };
  }),
}));

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

function createWindow(initialBounds: Bounds) {
  let bounds = initialBounds;
  return {
    getBounds: vi.fn(() => bounds),
    getContentBounds: vi.fn(() => bounds),
    setContentBounds: vi.fn((nextBounds: Bounds) => {
      bounds = nextBounds;
    }),
    isMaximized: vi.fn(() => false),
    isFullScreen: vi.fn(() => false),
  } as unknown as Electron.BrowserWindow;
}

describe('window right dock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps external window expansion in the right dock instead of rewriting the base width', async () => {
    const win = createWindow({ x: 100, y: 80, width: 1200, height: 800 });

    expect(setWindowRightDockWidth(win, 526, { currentDockWidth: 0 })).toEqual({ appliedWidth: 526 });
    expect(win.setContentBounds).toHaveBeenLastCalledWith({ x: 100, y: 80, width: 1726, height: 800 });

    win.setContentBounds({ x: 100, y: 80, width: 1926, height: 800 });

    await saveWindowState(win);
    expect(storeSetMock).toHaveBeenCalledWith('windowState', {
      x: 100,
      y: 80,
      width: 1200,
      height: 800,
      isMaximized: false,
    });

    expect(setWindowRightDockWidth(win, 0, { currentDockWidth: 726 })).toEqual({ appliedWidth: 0 });
    expect(win.setContentBounds).toHaveBeenLastCalledWith({ x: 100, y: 80, width: 1200, height: 800 });
  });
});
