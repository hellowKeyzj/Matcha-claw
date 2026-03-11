import { afterEach, describe, expect, it } from 'vitest';
import { link, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ensureBundledPluginsMirrorDir } from '../../electron/gateway/bundled-plugins-mirror';

const tempDirs: string[] = [];

async function mkTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

async function createOpenClawFixture(root: string): Promise<{ openclawDir: string; manifestPath: string }> {
  const openclawDir = path.join(root, 'openclaw');
  const sourceDir = path.join(openclawDir, 'extensions', 'memory-core');
  await mkdir(sourceDir, { recursive: true });

  await writeFile(
    path.join(openclawDir, 'package.json'),
    JSON.stringify({ name: 'openclaw', version: '2026.3.1' }, null, 2),
    'utf8',
  );

  const storeDir = path.join(root, 'store');
  await mkdir(storeDir, { recursive: true });
  const storeManifestPath = path.join(storeDir, 'openclaw.plugin.json');
  await writeFile(
    storeManifestPath,
    JSON.stringify({ id: 'memory-core', configSchema: { type: 'object' } }, null, 2),
    'utf8',
  );

  const manifestPath = path.join(sourceDir, 'openclaw.plugin.json');
  await link(storeManifestPath, manifestPath);
  await writeFile(path.join(sourceDir, 'package.json'), JSON.stringify({ name: 'memory-core' }, null, 2), 'utf8');

  return { openclawDir, manifestPath };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('ensureBundledPluginsMirrorDir', () => {
  it('在开发模式复制插件目录并打断 pnpm 硬链接', async () => {
    const root = await mkTempRoot('bundled-plugins-');
    const { openclawDir, manifestPath } = await createOpenClawFixture(root);
    const sourceStat = await stat(manifestPath);
    expect(sourceStat.nlink).toBeGreaterThan(1);

    const mirrorDir = path.join(root, 'mirror');
    const resolved = await ensureBundledPluginsMirrorDir({
      openclawDir,
      mirrorRootDir: mirrorDir,
      packaged: false,
    });

    expect(resolved).toBe(mirrorDir);
    const mirroredManifestPath = path.join(mirrorDir, 'memory-core', 'openclaw.plugin.json');
    expect(existsSync(mirroredManifestPath)).toBe(true);

    const mirrorStat = await stat(mirroredManifestPath);
    expect(mirrorStat.nlink).toBe(1);
  });

  it('源版本未变化时复用现有镜像目录', async () => {
    const root = await mkTempRoot('bundled-plugins-');
    const { openclawDir } = await createOpenClawFixture(root);
    const mirrorDir = path.join(root, 'mirror');

    await ensureBundledPluginsMirrorDir({
      openclawDir,
      mirrorRootDir: mirrorDir,
      packaged: false,
    });

    const sentinelPath = path.join(mirrorDir, 'sentinel.txt');
    await writeFile(sentinelPath, 'keep', 'utf8');

    await ensureBundledPluginsMirrorDir({
      openclawDir,
      mirrorRootDir: mirrorDir,
      packaged: false,
    });

    const sentinel = await readFile(sentinelPath, 'utf8');
    expect(sentinel).toBe('keep');
  });

  it('打包模式直接返回源 extensions 目录', async () => {
    const root = await mkTempRoot('bundled-plugins-');
    const { openclawDir } = await createOpenClawFixture(root);
    const mirrorDir = path.join(root, 'mirror');

    const resolved = await ensureBundledPluginsMirrorDir({
      openclawDir,
      mirrorRootDir: mirrorDir,
      packaged: true,
    });

    expect(resolved).toBe(path.join(openclawDir, 'extensions'));
    expect(existsSync(mirrorDir)).toBe(false);
  });
});
