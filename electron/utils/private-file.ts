import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);

export async function ensurePrivateDirectory(root: string): Promise<void> {
  if (!isAbsolute(root)) throw new Error('storage-unavailable');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('storage-unavailable');
  if (process.platform === 'win32') {
    const system = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
    const { stdout } = await executeFile(join(system, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, timeout: 5_000 });
    const sid = stdout.match(/S-1-\d+(?:-\d+)+/)?.[0];
    if (!sid) throw new Error('storage-unavailable');
    await executeFile(join(system, 'icacls.exe'), [root, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`], { windowsHide: true, timeout: 5_000 });
  } else await chmod(root, 0o700);
}

const RENAME_DELAYS = [50, 100, 200];
const RETRY_CODES = new Set(['EEXIST', 'EPERM', 'EACCES']);

export async function replacePrivateFile(path: string, contents: string | Buffer): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(directory, 0o700).catch(() => {});
  await replaceFileAtomically(path, contents);
  if (process.platform !== 'win32') await chmod(path, 0o600).catch(() => {});
}

export async function replaceFileAtomically(path: string, contents: string | Buffer, beforeCommit?: () => void | Promise<void>): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(contents); } finally { await file.close(); }
    if (process.platform !== 'win32') await chmod(temporary, 0o600).catch(() => {});
    for (let attempt = 0; ; attempt++) {
      try {
        const pending = beforeCommit?.();
        if (pending) await pending;
        await rename(temporary, path); break;
      } catch (error) {
        if (!RETRY_CODES.has((error as NodeJS.ErrnoException).code ?? '') || attempt === RENAME_DELAYS.length) throw error;
        await delay(RENAME_DELAYS[attempt]);
      }
    }
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function readBoundedFile(path: string, maximum: number): Promise<Buffer> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) throw new Error('App plugin storage file is invalid.');
  const file = await open(path, 'r');
  try {
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size !== stat.size) throw new Error('App plugin storage file changed during read.');
    return bytes.subarray(0, size);
  } finally {
    await file.close();
  }
}
