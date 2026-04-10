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

vi.mock('electron', () => ({
  BrowserWindow: class BrowserWindow {},
  app: {
    getVersion: () => '1.0.0',
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
});
