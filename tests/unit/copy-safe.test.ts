import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyDirectorySafe, copyDirectorySyncSafe } from '../../electron/utils/copy-safe';

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('copy-safe', () => {
  it('copyDirectorySyncSafe 可以复制嵌套目录内容', async () => {
    const root = await createTempDir('copy-safe-sync-');
    const sourceDir = join(root, 'source');
    const targetDir = join(root, 'target');
    await mkdir(join(sourceDir, 'nested'), { recursive: true });
    await writeFile(join(sourceDir, 'a.txt'), 'a', 'utf8');
    await writeFile(join(sourceDir, 'nested', 'b.txt'), 'b', 'utf8');

    copyDirectorySyncSafe(sourceDir, targetDir);

    await expect(readFile(join(targetDir, 'a.txt'), 'utf8')).resolves.toBe('a');
    await expect(readFile(join(targetDir, 'nested', 'b.txt'), 'utf8')).resolves.toBe('b');
  });

  it('copyDirectorySafe 可以覆盖已存在文件', async () => {
    const root = await createTempDir('copy-safe-async-');
    const sourceDir = join(root, 'source');
    const targetDir = join(root, 'target');
    await mkdir(sourceDir, { recursive: true });
    await mkdir(targetDir, { recursive: true });
    await writeFile(join(sourceDir, 'value.txt'), 'new-value', 'utf8');
    await writeFile(join(targetDir, 'value.txt'), 'old-value', 'utf8');

    await copyDirectorySafe(sourceDir, targetDir);

    await expect(readFile(join(targetDir, 'value.txt'), 'utf8')).resolves.toBe('new-value');
  });
});
