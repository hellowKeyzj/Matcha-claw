import { ipcMain } from 'electron';
import type { WorldPrivateActions } from '../../main/world/private-operations';

export function registerWorldPrivateHandlers(operations: WorldPrivateActions): void {
  ipcMain.handle('world:prepareEvaluation', (event, ...args: unknown[]) => operations.prepareEvaluation(event, args));
  ipcMain.handle('world:commitEvaluation', (event, ...args: unknown[]) => operations.commitEvaluation(event, args));
  ipcMain.handle('world:evaluationStatus', (event, ...args: unknown[]) => operations.evaluationStatus(event, args));
  ipcMain.handle('world:prepareAccess', (event, ...args: unknown[]) => operations.prepareAccess(event, args));
  ipcMain.handle('world:commitAccess', (event, ...args: unknown[]) => operations.commitAccess(event, args));
  ipcMain.handle('world:openStorage', (event, ...args: unknown[]) => operations.openStorage(event, args));
  ipcMain.handle('world:transferStorage', (event, input: unknown) => operations.transferStorage(event, input));
  ipcMain.handle('world:storageStatus', () => operations.storageStatus());
  ipcMain.handle('world:configureStorage', (event, input: unknown) => operations.configureStorage(event, input));
  ipcMain.handle('world:configureConnection', (event, input: unknown) => operations.configureConnection(event, input));
}
