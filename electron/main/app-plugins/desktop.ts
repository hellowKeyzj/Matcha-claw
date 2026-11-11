import { app, dialog, shell, type BrowserWindow } from 'electron';
import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { AppServiceError, type AppDesktopApi } from '../../../sdk/app-plugins/src/api';

async function localPath(path: string): Promise<string> {
  const local = (value: string) => isAbsolute(value) && (process.platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(value) : !value.startsWith('//'));
  if (!local(path)) throw new AppServiceError('invalid-request', 'An absolute local path is required.');
  let resolved: string;
  try { resolved = await realpath(path); }
  catch (error) {
    throw new AppServiceError((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not-found' : 'unavailable', 'The local path is unavailable.');
  }
  if (!local(resolved)) throw new AppServiceError('invalid-request', 'The path must resolve to a local file.');
  return resolved;
}

export function createAppPluginDesktop(getMainWindow: () => BrowserWindow | null): AppDesktopApi {
  return {
    async systemLocale(_input, signal) {
      signal?.throwIfAborted();
      return { locale: app.getSystemLocale() };
    },
    async openExternal({ url }, signal) {
      signal?.throwIfAborted();
      try { await shell.openExternal(url); }
      catch { throw new AppServiceError('unavailable', 'The external URL could not be opened.'); }
      return { opened: true };
    },
    async revealFile({ path }, signal) {
      signal?.throwIfAborted();
      const resolved = await localPath(path);
      signal?.throwIfAborted();
      shell.showItemInFolder(resolved);
      return { revealed: true };
    },
    async pickFile({ extensions }, signal) {
      signal?.throwIfAborted();
      const window = getMainWindow();
      if (!window || window.isDestroyed()) throw new AppServiceError('unavailable', 'The main window is unavailable.');
      const result = await dialog.showOpenDialog(window, {
        properties: ['openFile'], filters: [{ name: extensions.join(', '), extensions: [...extensions] }],
      });
      signal?.throwIfAborted();
      if (result.canceled || !result.filePaths.length) return { path: null };
      const path = await localPath(result.filePaths[0]!);
      signal?.throwIfAborted();
      return { path };
    },
  };
}
