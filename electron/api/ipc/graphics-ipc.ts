import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import type { GraphicsController } from '../../main/desktop/graphics';

export function registerGraphicsHandlers(graphics: GraphicsController, getWindow: () => BrowserWindow | null): () => void {
  const assertSender = (event: IpcMainInvokeEvent) => {
    const window = getWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('Graphics settings require the application main frame');
    }
  };
  ipcMain.handle('app:graphics-status', (event) => {
    assertSender(event);
    return graphics.readState();
  });
  ipcMain.handle('app:set-graphics-acceleration', (event, enabled: unknown) => {
    assertSender(event);
    if (typeof enabled !== 'boolean') throw new Error('Graphics acceleration must be a boolean');
    return graphics.setEnabled(enabled);
  });
  return () => {
    ipcMain.removeHandler('app:graphics-status');
    ipcMain.removeHandler('app:set-graphics-acceleration');
  };
}
