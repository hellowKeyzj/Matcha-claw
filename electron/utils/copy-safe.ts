import {
  cpSync,
  copyFileSync,
  mkdirSync,
  readdirSync,
  statSync,
} from 'node:fs';
import {
  cp,
  copyFile,
  mkdir,
  readdir,
  stat,
} from 'node:fs/promises';
import { join } from 'node:path';
import { fsPath } from './fs-path';

function copyDirSyncRecursive(sourceDir: string, targetDir: string): void {
  mkdirSync(targetDir, { recursive: true });
  const entries = readdirSync(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourceChild = join(sourceDir, entry.name);
    const targetChild = join(targetDir, entry.name);
    const info = statSync(sourceChild);
    if (info.isDirectory()) {
      copyDirSyncRecursive(sourceChild, targetChild);
      continue;
    }
    copyFileSync(sourceChild, targetChild);
  }
}

async function copyDirRecursive(sourceDir: string, targetDir: string): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourceChild = join(sourceDir, entry.name);
    const targetChild = join(targetDir, entry.name);
    const info = await stat(sourceChild);
    if (info.isDirectory()) {
      await copyDirRecursive(sourceChild, targetChild);
      continue;
    }
    await copyFile(sourceChild, targetChild);
  }
}

export function copyDirectorySyncSafe(sourceDir: string, targetDir: string): void {
  if (process.platform !== 'win32') {
    cpSync(fsPath(sourceDir), fsPath(targetDir), {
      recursive: true,
      force: true,
      dereference: true,
    });
    return;
  }
  copyDirSyncRecursive(fsPath(sourceDir), fsPath(targetDir));
}

export async function copyDirectorySafe(sourceDir: string, targetDir: string): Promise<void> {
  if (process.platform !== 'win32') {
    await cp(fsPath(sourceDir), fsPath(targetDir), {
      recursive: true,
      force: true,
      dereference: true,
    });
    return;
  }
  await copyDirRecursive(fsPath(sourceDir), fsPath(targetDir));
}
