import { app, ipcMain } from 'electron';

export function registerAppHandlers(): void {
  ipcMain.handle('app:version', () => {
    return app.getVersion();
  });

  ipcMain.handle('app:name', () => {
    return app.getName();
  });

  ipcMain.handle('app:platform', () => {
    return process.platform;
  });
}
