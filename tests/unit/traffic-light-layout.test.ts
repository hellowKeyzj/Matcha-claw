import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getMacTrafficLightPosition,
  syncMacTrafficLightPosition,
} from '../../electron/main/traffic-light-layout';

const originalPlatform = process.platform;

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
});

describe('macOS traffic light layout', () => {
  it('centers expanded traffic lights in the current title bar', () => {
    expect(getMacTrafficLightPosition(false, 24)).toEqual({ x: 16, y: 16 });
  });

  it('keeps collapsed traffic lights on the sidebar rail grid', () => {
    expect(getMacTrafficLightPosition(true, 24)).toEqual({ x: 8, y: 16 });
  });

  it('uses the Tahoe frame height for macOS 26', () => {
    expect(getMacTrafficLightPosition(false, 26)).toEqual({ x: 17, y: 17 });
  });

  it('only applies native button position on macOS live windows', () => {
    const setWindowButtonPosition = vi.fn();

    Object.defineProperty(process, 'platform', { value: 'darwin', writable: true });
    syncMacTrafficLightPosition({
      isDestroyed: () => false,
      setWindowButtonPosition,
    } as never, true);
    expect(setWindowButtonPosition).toHaveBeenCalledWith({ x: 8, y: 16 });

    Object.defineProperty(process, 'platform', { value: 'win32', writable: true });
    syncMacTrafficLightPosition({
      isDestroyed: () => false,
      setWindowButtonPosition,
    } as never, true);
    expect(setWindowButtonPosition).toHaveBeenCalledTimes(1);
  });
});
