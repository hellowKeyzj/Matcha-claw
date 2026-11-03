import { ipcMain } from 'electron';
import type { ProviderPrivateAuthActions } from '../../main/providers/private-auth';

export function registerProviderPrivateAuthHandlers(provider: ProviderPrivateAuthActions): void {
  ipcMain.handle('providers:discoverModels', (_, input: unknown) => provider.discoverModels(input));
  ipcMain.handle('providers:storeAccount', (_, input: unknown) => provider.storeAccount(input));
  ipcMain.handle('providers:deleteAccount', (_, input: unknown) => provider.deleteAccount(input));
  ipcMain.handle('providers:startOAuth', (_, input: unknown) => provider.startOAuth(input));
  ipcMain.handle('providers:submitOAuthCode', (_, input: unknown) => provider.submitOAuthCode(input));
  ipcMain.handle('providers:cancelOAuth', (_, input: unknown) => provider.cancelOAuth(input));
}
