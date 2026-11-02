import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import type { IabApplication } from '../../main/iab/composition';
import { decodeIabOverlayCommand, decodeIabUiRequest } from '../../main/iab/ui-input';
import { getIabOverlay, iabActionError } from '../../main/iab/overlay';

export function registerIabHandlers(iab: IabApplication, getWindow: () => BrowserWindow | null): () => void {
  const assertSender = (event: IpcMainInvokeEvent) => {
    const window = getWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('In-app browser requests require the application main frame');
    }
  };
  ipcMain.handle('iab:command', (event, value: unknown) => {
    assertSender(event);
    return iab.command(decodeIabUiRequest(value));
  });
  ipcMain.handle('iab:snapshot', (event) => { assertSender(event); return iab.snapshot(); });
  const trustedOverlay = (event: IpcMainInvokeEvent) => {
    const overlay = getIabOverlay(event.sender);
    if (!overlay || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== overlay.entryUrl) {
      throw new Error('Untrusted browser tools overlay sender');
    }
    return overlay;
  };
  ipcMain.handle('iab:overlay:getState', (event) => trustedOverlay(event).state);
  ipcMain.handle('iab:overlay:command', async (event, value: unknown) => {
    try { await trustedOverlay(event).execute(decodeIabOverlayCommand(value)); }
    catch (error) { throw new Error(iabActionError(error), { cause: error }); }
  });
  return () => {
    for (const channel of ['iab:command', 'iab:snapshot', 'iab:overlay:getState', 'iab:overlay:command']) ipcMain.removeHandler(channel);
  };
}
