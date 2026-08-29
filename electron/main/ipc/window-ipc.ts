import { ipcMain, type BrowserWindow } from 'electron';
import { setWindowRightDockWidth } from '../window';

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

  ipcMain.handle('window:setRightDockWidth', async (_event, width: unknown, options: unknown) => {
    if (typeof width !== 'number' || !Number.isFinite(width)) {
      throw new Error('Right dock width must be a finite number');
    }
    const resizeWindow = options && typeof options === 'object' && 'resizeWindow' in options
      ? (options as { resizeWindow?: unknown }).resizeWindow !== false
      : true;
    const currentDockWidth = options && typeof options === 'object' && typeof (options as { currentDockWidth?: unknown }).currentDockWidth === 'number'
      ? (options as { currentDockWidth: number }).currentDockWidth
      : undefined;
    const mainWindow = requireMainWindow(getMainWindow);
    return setWindowRightDockWidth(mainWindow, width, { resizeWindow, currentDockWidth });
  });
}
