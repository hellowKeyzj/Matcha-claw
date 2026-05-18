import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const mockAutoUpdater = Object.assign(new EventEmitter(), {
  autoDownload: false,
  autoInstallOnAppQuit: true,
  logger: undefined as unknown,
  channel: '',
  checkForUpdates: vi.fn(async () => null),
  downloadUpdate: vi.fn(async () => undefined),
  quitAndInstall: vi.fn(),
});

vi.mock('electron-updater', () => ({
  autoUpdater: mockAutoUpdater,
}));

const electronMock = vi.hoisted(() => ({
  appVersion: '1.0.0',
}));

vi.mock('electron', () => ({
  BrowserWindow: class BrowserWindow {},
  app: {
    getVersion: () => electronMock.appVersion,
  },
  ipcMain: {
    handle: vi.fn(),
  },
}));

vi.mock('../../electron/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('AppUpdater 错误事件兜底', () => {
  beforeEach(() => {
    electronMock.appVersion = '1.0.0';
    mockAutoUpdater.removeAllListeners();
  });

  it('autoUpdater 触发 error 时不会因未监听而抛出致命异常', async () => {
    const { AppUpdater } = await import('../../electron/main/updater');
    const updater = new AppUpdater();

    expect(() => {
      mockAutoUpdater.emit('error', new Error('network failed'));
    }).not.toThrow();

    expect(updater.getStatus().status).toBe('error');
    expect(updater.getStatus().error).toBe('network failed');
  });

  it('uses prompt-first updater settings instead of automatic install on quit', async () => {
    const { AppUpdater } = await import('../../electron/main/updater');
    new AppUpdater();

    expect(mockAutoUpdater.autoDownload).toBe(false);
    expect(mockAutoUpdater.autoInstallOnAppQuit).toBe(false);
  });

  it('ignores update-available events for versions older than the running app', async () => {
    electronMock.appVersion = '1.0.1';
    const { AppUpdater } = await import('../../electron/main/updater');
    const updater = new AppUpdater();

    mockAutoUpdater.emit('update-available', { version: '1.0.0' });

    expect(updater.getStatus().status).toBe('not-available');
    expect(updater.getStatus().info).toBeUndefined();
  });
});
