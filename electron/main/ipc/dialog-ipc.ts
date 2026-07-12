import { dialog, ipcMain } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import {
  getE2EDialogOpenResult,
  getE2EDialogStagedAttachments,
} from '@electron/e2e-fixture-loader';
import { stageDialogSelectedAttachments } from './dialog-attachment-staging';

export function registerDialogHandlers(): void {
  ipcMain.handle('dialog:open', async (_, options: Electron.OpenDialogOptions) => {
    const e2eResult = await getE2EDialogOpenResult();
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

  ipcMain.handle('dialog:stageOpenAttachments', async (_, options: Electron.OpenDialogOptions) => {
    const e2eAttachments = await getE2EDialogStagedAttachments();
    if (e2eAttachments) {
      return { canceled: false, attachments: e2eAttachments };
    }

    const result = await dialog.showOpenDialog({
      ...options,
      properties: [...new Set([...(options.properties ?? []), 'openFile', 'multiSelections'])],
    });
    if (result.canceled) {
      return { canceled: true };
    }
    return {
      canceled: false,
      attachments: await stageDialogSelectedAttachments(result.filePaths),
    };
  });

  ipcMain.handle('dialog:readSelectedTextFile', async (_, options: Electron.OpenDialogOptions) => {
    const result = await dialog.showOpenDialog({
      ...options,
      properties: ['openFile'],
    });
    const filePath = result.filePaths[0];
    if (result.canceled || !filePath) {
      return { canceled: true };
    }
    return {
      canceled: false,
      filePath,
      content: await readFile(filePath, 'utf8'),
    };
  });

  ipcMain.handle('dialog:writeSelectedTextFile', async (_, options: Electron.SaveDialogOptions, content: string) => {
    if (typeof content !== 'string') {
      throw new Error('content is required');
    }
    const result = await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) {
      return { canceled: true };
    }
    await writeFile(result.filePath, content, 'utf8');
    return { canceled: false, filePath: result.filePath };
  });
}
