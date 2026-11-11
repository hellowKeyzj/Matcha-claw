import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import type { AppPluginHost } from '../../main/app-plugins/host';
import { requireDigest, requireObject, requirePluginId } from '../../main/app-plugins/package';

export function registerAppPluginConfirmationHandlers(host: AppPluginHost, window: BrowserWindow): () => void {
  const webContents = window.webContents;
  const owners = new Map<string, { pluginId: string; digest: string; effective: boolean }>();
  const refresh = () => {
    const effective = !window.isDestroyed() && window.isVisible() && window.isFocused();
    for (const [ownerId, owner] of owners) {
      if (owner.effective === effective) continue;
      owner.effective = effective;
      host.confirmations.setOwner(ownerId, owner.pluginId, owner.digest, effective);
    }
  };
  const assertSender = (event: IpcMainInvokeEvent) => {
    if (window.isDestroyed() || event.sender !== webContents || event.senderFrame !== webContents.mainFrame) throw new Error('Confirmation requires the trusted application main frame.');
  };
  ipcMain.handle('app-plugins:confirmation-owner', (event, value: unknown) => {
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
    const owner = owners.get(input.ownerId);
    if (!owner || owner.pluginId !== input.pluginId || owner.digest !== input.digest) {
      if (owner) host.confirmations.removeOwner(input.ownerId);
      owners.set(input.ownerId, { pluginId: input.pluginId, digest: input.digest, effective: false });
    }
    refresh();
  });
  ipcMain.handle('app-plugins:confirmation-decide', (event, value: unknown) => {
    assertSender(event);
    const input = requireObject(value, ['ownerId', 'requestId', 'allowed']);
    if (typeof input.ownerId !== 'string' || typeof input.requestId !== 'string' || typeof input.allowed !== 'boolean') throw new Error('Invalid confirmation decision.');
    if (!owners.get(input.ownerId)?.effective || input.allowed && (!window.isVisible() || !window.isFocused())) return false;
    return host.confirmations.decide(input.ownerId, input.requestId, input.allowed);
  });
  const clear = () => {
    for (const ownerId of owners.keys()) host.confirmations.removeOwner(ownerId);
    owners.clear();
  };
  window.on('blur', refresh);
  window.on('hide', refresh);
  window.on('focus', refresh);
  window.on('show', refresh);
  webContents.on('render-process-gone', clear);
  webContents.on('did-start-loading', clear);
  return () => {
    clear();
    window.removeListener('blur', refresh);
    window.removeListener('hide', refresh);
    window.removeListener('focus', refresh);
    window.removeListener('show', refresh);
    webContents.removeListener('render-process-gone', clear);
    webContents.removeListener('did-start-loading', clear);
    ipcMain.removeHandler('app-plugins:confirmation-owner');
    ipcMain.removeHandler('app-plugins:confirmation-decide');
  };
}
