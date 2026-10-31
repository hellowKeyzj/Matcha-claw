import { BrowserWindow, dialog, ipcMain } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { readSkillImport } from '../../main/skills/import';
import {
  getE2EDialogOpenResult,
  getE2EDialogStagedAttachments,
} from '@electron/e2e-fixture-loader';
import {
  releaseStagedAttachments,
  stageDialogSelectedAttachments,
  stageRendererBufferAttachment,
} from '../../main/attachments/staging';

export function registerDialogHandlers(): void {
  ipcMain.handle('dialog:open', async (event, options: Electron.OpenDialogOptions) => {
    const e2eResult = await getE2EDialogOpenResult();
    if (e2eResult) {
      return e2eResult;
    }
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner || owner.isDestroyed()) {
      throw new Error('Dialog owner is not available');
    }
    return await dialog.showOpenDialog(owner, options);
  });

  ipcMain.handle('dialog:save', async (_, options: Electron.SaveDialogOptions) => {
    return await dialog.showSaveDialog(options);
  });

  ipcMain.handle('dialog:message', async (_, options: Electron.MessageBoxOptions) => {
    return await dialog.showMessageBox(options);
  });

  ipcMain.handle('dialog:stageRendererBufferAttachment', async (_, input: unknown) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('invalid');
    }
    const { base64, fileName, mimeType } = input as Record<string, unknown>;
    if (typeof base64 !== 'string' || typeof fileName !== 'string' || typeof mimeType !== 'string') {
      throw new Error('invalid');
    }
    return await stageRendererBufferAttachment({ base64, fileName, mimeType });
  });

  ipcMain.handle('dialog:stageDroppedAttachments', async (_, filePaths: unknown) => {
    if (!Array.isArray(filePaths) || filePaths.some((filePath) => typeof filePath !== 'string' || !filePath)) {
      throw new Error('invalid');
    }
    return { attachments: await stageDialogSelectedAttachments(filePaths) };
  });

  ipcMain.handle('dialog:releaseStagedAttachments', async (_, stagedAttachmentIds: unknown) => {
    if (!Array.isArray(stagedAttachmentIds)
      || stagedAttachmentIds.some((stagedAttachmentId) => typeof stagedAttachmentId !== 'string' || !stagedAttachmentId)) {
      throw new Error('invalid');
    }
    await releaseStagedAttachments(stagedAttachmentIds);
  });

  ipcMain.handle('dialog:stageOpenAttachments', async (_, options: Electron.OpenDialogOptions) => {
    const e2eAttachments = await getE2EDialogStagedAttachments();
    if (e2eAttachments) {
      return { canceled: false, attachments: e2eAttachments };
    }

    const result = await dialog.showOpenDialog({
      ...options,
      properties: ['openFile', 'multiSelections'],
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

  ipcMain.handle('dialog:readSkillImport', async (_, sourcePath?: unknown) => {
    let selected: string | undefined;
    if (sourcePath === undefined) {
      const result = await dialog.showOpenDialog({
        title: '导入技能',
        properties: ['openFile', 'openDirectory'],
        filters: [{ name: 'Skill Markdown', extensions: ['md', 'markdown'] }],
      });
      selected = result.filePaths[0];
      if (result.canceled || !selected) return { canceled: true };
    } else {
      if (typeof sourcePath !== 'string' || !sourcePath.trim()) throw new Error('invalid');
      selected = sourcePath.trim();
    }
    return await readSkillImport(selected);
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
