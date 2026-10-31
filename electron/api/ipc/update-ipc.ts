import { app, ipcMain, type BrowserWindow } from 'electron';
import type { AppUpdater, UpdateStatus } from '../../main/updates/updater';

export function registerE2EUpdateHandlers(): void {
  ipcMain.handle('update:status', () => ({ status: 'idle' }));
  ipcMain.handle('update:version', () => app.getVersion());
  ipcMain.handle('update:check', () => ({ success: true, status: { status: 'idle' } }));
  ipcMain.handle('update:download', () => ({ accepted: false, error: 'Updates are disabled in E2E mode.' }));
  ipcMain.handle('update:install', () => ({ success: false, error: 'Updates are disabled in E2E mode.' }));
  ipcMain.handle('update:setChannel', () => ({ success: false, error: 'Updates are disabled in E2E mode.' }));
}

export function registerUpdateHandlers(
  updater: AppUpdater,
  mainWindow: BrowserWindow
): void {
  const sendStatus = (status: UpdateStatus): void => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update:status-changed', status);
    }
  };
  updater.on('status-changed', sendStatus);
  mainWindow.once('closed', () => updater.removeListener('status-changed', sendStatus));

  // Get current update status
  ipcMain.handle('update:status', () => {
    return updater.getStatus();
  });

  // Get current version
  ipcMain.handle('update:version', () => {
    return updater.getCurrentVersion();
  });

  // Check for updates – always return final status so the renderer
  // never gets stuck in 'checking' waiting for a push event.
  ipcMain.handle('update:check', async () => {
    try {
      await updater.checkForUpdates();
      return { success: true, status: updater.getStatus() };
    } catch (error) {
      return { success: false, error: String(error), status: updater.getStatus() };
    }
  });

  // Download update
  ipcMain.handle('update:download', () => updater.downloadUpdate());

  // Install update and restart
  ipcMain.handle('update:install', () => {
    updater.quitAndInstall();
    return { success: true };
  });

  // Set update channel
  ipcMain.handle('update:setChannel', (_, channel: 'stable' | 'beta' | 'dev') => {
    updater.setChannel(channel);
    return { success: true };
  });
}
