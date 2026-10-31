import { ipcMain } from 'electron';
import { splitSettingsProxyIntent, type ProxyIntent } from '../../main/settings/proxy-intent';

export function registerSettingsPrivateProxyHandlers(): void {
  ipcMain.handle('settings:splitProxyIntent', async (_, input: ProxyIntent) => {
    return await splitSettingsProxyIntent(input);
  });
}
