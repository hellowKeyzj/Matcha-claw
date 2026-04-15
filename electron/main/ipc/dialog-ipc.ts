import { dialog, ipcMain } from 'electron';
import { getE2EDialogOpenResult } from './e2e-chat';

export function registerDialogHandlers(): void {
  ipcMain.handle('dialog:open', async (_, options: Electron.OpenDialogOptions) => {
    const e2eResult = getE2EDialogOpenResult();
    if (e2eResult) {
      return e2eResult;
    }
    return await dialog.showOpenDialog(options);
  });

  ipcMain.handle('dialog:save', async (_, options: Electron.SaveDialogOptions) => {
    return await dialog.showSaveDialog(options);
  });

  ipcMain.handle('dialog:message', async (_, options: Electron.MessageBoxOptions) => {
    return await dialog.showMessageBox(options);
  });
}
