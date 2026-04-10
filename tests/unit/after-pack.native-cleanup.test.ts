import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

type AfterPackTestExports = {
  cleanupNativePlatformPackages: (nodeModulesDir: string, platform: string, arch: string) => number;
};

async function loadAfterPackTestApi(): Promise<AfterPackTestExports> {
  const mod = await import('../../scripts/after-pack.cjs') as {
    __test__?: AfterPackTestExports;
    default?: { __test__?: AfterPackTestExports };
  };
  const api = mod.__test__ ?? mod.default?.__test__;
  if (!api) {
    throw new Error('after-pack test API not found');
  }
  return api;
}

describe('after-pack native cleanup', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (!dir) {
        continue;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('保留目标平台架构的 scoped/unscoped 原生包并删除其余变体', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matchaclaw-after-pack-'));
    tempDirs.push(root);
    const nodeModulesDir = join(root, 'node_modules');
    await mkdir(join(nodeModulesDir, '@snazzah', 'davey-win32-x64-msvc'), { recursive: true });
    await mkdir(join(nodeModulesDir, '@snazzah', 'davey-win32-arm64-msvc'), { recursive: true });
    await mkdir(join(nodeModulesDir, '@snazzah', 'davey-linux-x64-gnu'), { recursive: true });
    await mkdir(join(nodeModulesDir, 'sqlite-vec-windows-x64'), { recursive: true });
    await mkdir(join(nodeModulesDir, 'sqlite-vec-darwin-arm64'), { recursive: true });

    const { cleanupNativePlatformPackages } = await loadAfterPackTestApi();
    const removed = cleanupNativePlatformPackages(nodeModulesDir, 'win32', 'x64');

    expect(removed).toBe(3);
    expect(existsSync(join(nodeModulesDir, '@snazzah', 'davey-win32-x64-msvc'))).toBe(true);
    expect(existsSync(join(nodeModulesDir, 'sqlite-vec-windows-x64'))).toBe(true);
    expect(existsSync(join(nodeModulesDir, '@snazzah', 'davey-win32-arm64-msvc'))).toBe(false);
    expect(existsSync(join(nodeModulesDir, '@snazzah', 'davey-linux-x64-gnu'))).toBe(false);
    expect(existsSync(join(nodeModulesDir, 'sqlite-vec-darwin-arm64'))).toBe(false);
  });

  it('支持 linuxmusl 平台别名映射为 linux', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matchaclaw-after-pack-'));
    tempDirs.push(root);
    const nodeModulesDir = join(root, 'node_modules');
    await mkdir(join(nodeModulesDir, '@img', 'sharp-linuxmusl-x64'), { recursive: true });
    await mkdir(join(nodeModulesDir, '@img', 'sharp-win32-x64'), { recursive: true });

    const { cleanupNativePlatformPackages } = await loadAfterPackTestApi();
    const removed = cleanupNativePlatformPackages(nodeModulesDir, 'linux', 'x64');

    expect(removed).toBe(1);
    expect(existsSync(join(nodeModulesDir, '@img', 'sharp-linuxmusl-x64'))).toBe(true);
    expect(existsSync(join(nodeModulesDir, '@img', 'sharp-win32-x64'))).toBe(false);
  });
});
