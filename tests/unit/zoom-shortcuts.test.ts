import { describe, expect, it, vi } from 'vitest';
import { getZoomShortcutAction, registerZoomShortcuts } from '../../electron/main/zoom-shortcuts';

describe('zoom shortcuts', () => {
  it('matches Windows-friendly zoom key variants', () => {
    expect(getZoomShortcutAction({
      key: '=',
      code: 'Equal',
      control: true,
      meta: false,
      alt: false,
    })).toBe('in');
    expect(getZoomShortcutAction({
      key: '-',
      code: 'Minus',
      control: true,
      meta: false,
      alt: false,
    })).toBe('out');
    expect(getZoomShortcutAction({
      key: '0',
      code: 'Digit0',
      control: true,
      meta: false,
      alt: false,
    })).toBe('reset');
    expect(getZoomShortcutAction({
      key: '=',
      code: 'Equal',
      control: false,
      meta: false,
      alt: false,
    })).toBeNull();
  });

  it('updates zoom level from before-input-event', () => {
    let zoomLevel = 2;
    let handler: ((event: { preventDefault: () => void }, input: Electron.Input) => void) | null = null;
    const preventDefault = vi.fn();
    const onMock = vi.fn((eventName: string, nextHandler: typeof handler) => {
      if (eventName === 'before-input-event') {
        handler = nextHandler;
      }
    });
    const win = {
      webContents: {
        on: onMock,
        getZoomLevel: vi.fn(() => zoomLevel),
        setZoomLevel: vi.fn((nextLevel: number) => {
          zoomLevel = nextLevel;
        }),
      },
    } as unknown as Electron.BrowserWindow;

    registerZoomShortcuts(win);
    expect(onMock).toHaveBeenCalledTimes(1);

    handler?.({ preventDefault }, {
      key: '=',
      code: 'Equal',
      control: true,
      meta: false,
      alt: false,
    } as Electron.Input);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(zoomLevel).toBe(3);

    handler?.({ preventDefault }, {
      key: '0',
      code: 'Digit0',
      control: true,
      meta: false,
      alt: false,
    } as Electron.Input);
    expect(zoomLevel).toBe(0);
  });
});
