import { ipcMain, type BrowserWindow } from 'electron';

function requireMainWindow(getMainWindow: () => BrowserWindow | null): BrowserWindow {
  const mainWindow = getMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error('Main window is not available');
  }
  return mainWindow;
}

export function registerWindowHandlers(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle('window:minimize', () => {
    const mainWindow = requireMainWindow(getMainWindow);
    mainWindow.minimize();
  });

  ipcMain.handle('window:maximize', () => {
    const mainWindow = requireMainWindow(getMainWindow);
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  });

  ipcMain.handle('window:close', () => {
    const mainWindow = requireMainWindow(getMainWindow);
    mainWindow.close();
  });

  ipcMain.handle('window:isMaximized', () => {
    const mainWindow = requireMainWindow(getMainWindow);
    return mainWindow.isMaximized();
  });
}
