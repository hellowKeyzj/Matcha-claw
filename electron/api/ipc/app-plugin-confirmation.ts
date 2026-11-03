import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import type { AppPluginHost } from '../../main/app-plugins/host';
import { requireDigest, requireObject, requirePluginId } from '../../main/app-plugins/package';

export function registerAppPluginConfirmationHandlers(host: AppPluginHost, window: BrowserWindow): () => void {
  const webContents = window.webContents;
  const owners = new Set<string>();
  const assertSender = (event: IpcMainInvokeEvent) => {
    if (window.isDestroyed() || event.sender !== webContents || event.senderFrame !== webContents.mainFrame) throw new Error('Confirmation requires the trusted application main frame.');
  };
  ipcMain.handle('app-plugins:confirmation-owner', async (event, value: unknown) => {
    assertSender(event);
    const input = requireObject(value, ['ownerId', 'pluginId', 'digest', 'active']);
    if (typeof input.ownerId !== 'string' || !/^[a-f0-9-]{36}$/.test(input.ownerId) || typeof input.active !== 'boolean') throw new Error('Invalid confirmation owner.');
    requirePluginId(input.pluginId);
    requireDigest(input.digest);
    if (!input.active) {
      owners.delete(input.ownerId);
      host.confirmations.removeOwner(input.ownerId);
      return;
    }
    if (!window.isVisible() || !window.isFocused()) throw new Error('Approval unavailable: the application is not in the foreground.');
    owners.add(input.ownerId);
    host.confirmations.setOwner(input.ownerId, input.pluginId, input.digest, true);
  });
  ipcMain.handle('app-plugins:confirmation-decide', (event, value: unknown) => {
    assertSender(event);
    const input = requireObject(value, ['ownerId', 'requestId', 'allowed']);
    if (typeof input.ownerId !== 'string' || typeof input.requestId !== 'string' || typeof input.allowed !== 'boolean') throw new Error('Invalid confirmation decision.');
    if (!owners.has(input.ownerId) || input.allowed && (!window.isVisible() || !window.isFocused())) return false;
    return host.confirmations.decide(input.ownerId, input.requestId, input.allowed);
  });
  const clear = () => {
    for (const ownerId of owners) host.confirmations.removeOwner(ownerId);
    owners.clear();
  };
  window.on('blur', clear);
  window.on('hide', clear);
  webContents.on('render-process-gone', clear);
  webContents.on('did-start-loading', clear);
  return () => {
    clear();
    window.removeListener('blur', clear);
    window.removeListener('hide', clear);
    webContents.removeListener('render-process-gone', clear);
    webContents.removeListener('did-start-loading', clear);
    ipcMain.removeHandler('app-plugins:confirmation-owner');
    ipcMain.removeHandler('app-plugins:confirmation-decide');
  };
}
