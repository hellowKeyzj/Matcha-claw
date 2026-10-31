import { release } from 'node:os';
import type { BrowserWindow } from 'electron';

const MAC_TITLE_BAR_HEIGHT = 48;
const MAC_TRAFFIC_LIGHT_GAP = 8;
const MAC_TRAFFIC_LIGHT_FRAME_HEIGHT = 16;
const MAC_TRAFFIC_LIGHT_FRAME_HEIGHT_TAHOE = 14;

function darwinMajorVersion(): number {
  return Number.parseInt(release().split('.')[0] ?? '0', 10);
}

function getMacTrafficLightFrameHeight(darwinMajor: number): number {
  return darwinMajor >= 25
    ? MAC_TRAFFIC_LIGHT_FRAME_HEIGHT_TAHOE
    : MAC_TRAFFIC_LIGHT_FRAME_HEIGHT;
}

export function getMacTrafficLightPosition(
  sidebarCollapsed: boolean,
  darwinMajor = darwinMajorVersion(),
): { x: number; y: number } {
  const buttonFrameHeight = getMacTrafficLightFrameHeight(darwinMajor);
  const centeredOffset = Math.floor((MAC_TITLE_BAR_HEIGHT - buttonFrameHeight) / 2);

  return {
    x: sidebarCollapsed ? MAC_TRAFFIC_LIGHT_GAP : centeredOffset,
    y: centeredOffset,
  };
}

export function syncMacTrafficLightPosition(
  win: BrowserWindow,
  sidebarCollapsed: boolean,
): void {
  if (process.platform !== 'darwin' || win.isDestroyed()) {
    return;
  }

  win.setWindowButtonPosition(getMacTrafficLightPosition(sidebarCollapsed));
}
