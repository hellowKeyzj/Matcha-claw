import { dialog, ipcMain } from 'electron';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, relative, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  getE2EDialogOpenResult,
  getE2EDialogStagedAttachments,
} from '@electron/e2e-fixture-loader';
import {
  releaseStagedAttachments,
  stageDialogSelectedAttachments,
  stageRendererBufferAttachment,
} from './dialog-attachment-staging';

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
    const selectedStat = await stat(selected);
    if (selectedStat.isFile()) {
      if (!['.md', '.markdown'].includes(extname(selected).toLowerCase())) throw new Error('invalid');
      const content = await readBoundedText(selected);
      return {
        canceled: false,
        kind: 'markdown',
        skillKey: deriveSkillKey(content),
        content,
      };
    }
    if (!selectedStat.isDirectory()) throw new Error('invalid');
    const files: Array<{ path: string; content: string }> = [];
    await collectSkillFiles(selected, selected, files, 0);
    const manifest = files.find((file) => file.path.toLowerCase() === 'skill.md');
    if (!manifest) throw new Error('invalid');
    return {
      canceled: false,
      kind: 'bundle',
      skillKey: deriveSkillKey(manifest.content),
      files,
    };
  });

const SKILL_IMPORT_MAX_FILES = 256;
const SKILL_IMPORT_MAX_FILE_BYTES = 48 * 1024;
const SKILL_IMPORT_MAX_TOTAL_BYTES = 48 * 1024;
const SKILL_IMPORT_MAX_DEPTH = 8;
const SKILL_IMPORT_MAX_KEY_BYTES = 96;

function deriveSkillKey(content: string): string {
  const frontmatterStart = content.startsWith('---\n')
    ? '---\n'
    : content.startsWith('---\r\n')
      ? '---\r\n'
      : null;
  if (!frontmatterStart) {
    throw new Error('invalid');
  }
  const frontmatterContent = content.slice(frontmatterStart.length);
  const closingMarker = frontmatterContent.indexOf('\n---');
  if (closingMarker < 0) {
    throw new Error('invalid');
  }
  const frontmatter = frontmatterContent.slice(0, closingMarker);
  let document: unknown;
  try {
    document = parseYaml(frontmatter);
  } catch {
    throw new Error('invalid');
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('invalid');
  }
  const manifest = document as Record<string, unknown>;
  const name = manifest.name;
  const description = manifest.description;
  if (typeof name !== 'string' || typeof description !== 'string' || description.trim().length === 0) {
    throw new Error('invalid');
  }
  const normalized = name.trim().split(/\s+/u).join('-').replace(/[A-Z]/g, (character) => character.toLowerCase());
  if (
    normalized.length === 0
    || Buffer.byteLength(normalized, 'utf8') > SKILL_IMPORT_MAX_KEY_BYTES
    || !normalized
      .split('')
      .every((character, index) => /^[A-Za-z0-9]$/.test(character) || (index > 0 && character === '-'))
    || normalized.endsWith('-')
  ) {
    throw new Error('invalid');
  }
  return normalized;
}

async function readBoundedText(filePath: string): Promise<string> {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile() || fileStat.size > SKILL_IMPORT_MAX_FILE_BYTES) throw new Error('invalid');
  const content = await readFile(filePath, 'utf8');
  if (Buffer.byteLength(content, 'utf8') > SKILL_IMPORT_MAX_FILE_BYTES || content.includes('\0')) throw new Error('invalid');
  return content;
}

async function collectSkillFiles(root: string, current: string, files: Array<{ path: string; content: string }>, depth: number, total = { value: 0 }): Promise<void> {
  if (depth > SKILL_IMPORT_MAX_DEPTH || files.length >= SKILL_IMPORT_MAX_FILES) throw new Error('invalid');
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const absolute = `${current}${sep}${entry.name}`;
    if (entry.isDirectory()) {
      await collectSkillFiles(root, absolute, files, depth + 1, total);
      continue;
    }
    if (!entry.isFile()) continue;
    const relativePath = relative(root, absolute).split(sep).join('/');
    if (!relativePath || relativePath.includes('..')) throw new Error('invalid');
    const content = await readBoundedText(absolute);
    total.value += Buffer.byteLength(content, 'utf8');
    if (total.value > SKILL_IMPORT_MAX_TOTAL_BYTES) throw new Error('invalid');
    files.push({ path: relativePath, content });
  }
}

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
