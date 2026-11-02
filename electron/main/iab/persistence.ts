import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const RENAME_DELAYS = [50, 100, 200];
const RETRY_CODES = new Set(['EEXIST', 'EPERM', 'EACCES']);

export async function replacePrivateFile(path: string, contents: string | Buffer): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(directory, 0o700).catch(() => {});
  await replaceFileAtomically(path, contents);
  if (process.platform !== 'win32') await chmod(path, 0o600).catch(() => {});
}

export async function replaceFileAtomically(path: string, contents: string | Buffer, beforeCommit?: () => void): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(contents); } finally { await file.close(); }
    if (process.platform !== 'win32') await chmod(temporary, 0o600).catch(() => {});
    for (let attempt = 0; ; attempt++) {
      try { beforeCommit?.(); await rename(temporary, path); break; }
      catch (error) {
        if (!RETRY_CODES.has((error as NodeJS.ErrnoException).code ?? '') || attempt === RENAME_DELAYS.length) throw error;
        await delay(RENAME_DELAYS[attempt]);
      }
    }
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
