import { ipcMain, shell } from 'electron';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { expandPath } from '../../utils/paths';
import { logger } from '../../utils/logger';

function isAllowedExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

export function registerShellHandlers(): void {
  ipcMain.handle('shell:openExternal', async (_, url: string) => {
    if (!isAllowedExternalUrl(url)) {
      throw new Error(`Blocked openExternal for disallowed URL: ${url}`);
    }
    await shell.openExternal(url);
  });

  ipcMain.handle('shell:showItemInFolder', async (_, path: string) => {
    const rawPath = typeof path === 'string' ? path.trim() : '';
    if (!rawPath) {
      return { success: false, error: 'empty_path' };
    }

    const decodedPath = (() => {
      try {
        return decodeURIComponent(rawPath);
      } catch {
        return rawPath;
      }
    })();
    const expandedPath = expandPath(decodedPath);
    if (!isAbsolute(expandedPath)) {
      logger.warn(`[shell:showItemInFolder] relative path rejected: "${rawPath}"`);
      return { success: false, error: 'relative_path_not_supported', rawPath };
    }
    const resolvedPath = resolvePath(expandedPath);
    if (!existsSync(resolvedPath)) {
      logger.warn(`[shell:showItemInFolder] target not found: raw="${rawPath}" resolved="${resolvedPath}"`);
      return { success: false, error: 'not_found', rawPath, resolvedPath };
    }
    shell.showItemInFolder(resolvedPath);
    return { success: true, resolvedPath, source: 'absolute' };
  });

  ipcMain.handle('shell:openPath', async (_, path: string) => {
    return await shell.openPath(path);
  });
}
