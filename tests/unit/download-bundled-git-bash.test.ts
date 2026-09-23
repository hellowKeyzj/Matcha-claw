import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  assertPortableGitLayout,
  canReusePortableGitDistribution,
  createGitForWindowsDownloadPlan,
  gitForWindowsTargets,
  parseGitForWindowsDownloadArgs,
  publishPortableGitDistribution,
  removePackagingIncompatibleLinks,
} from '../../scripts/download-bundled-git-bash.mjs';

const temporaryRoots: string[] = [];

function createTemporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'matchaclaw-git-for-windows-'));
  temporaryRoots.push(root);
  return root;
}

function writePortableGitLayout(root: string): void {
  for (const relativePath of [
    'bin/bash.exe',
    'cmd/git.exe',
    'usr/bin/bash.exe',
    'usr/bin/msys-2.0.dll',
  ]) {
    const path = join(root, relativePath);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, relativePath);
  }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Git for Windows delivery', () => {
  it.each([
    ['x64', 'Git-2.55.0.3-64-bit.tar.bz2', '4ee071816e424f928f493c4b42e5486d05344a371665c82f1802ebcecaa1d19a'],
    ['arm64', 'Git-2.55.0.3-arm64.tar.bz2', 'ff753aa49b9baeafda33470128ee799b19e48b06736d3c555585bc926dc13b2d'],
  ])('pins the complete PortableGit archive and checksum for %s', (arch, archiveName, sha256) => {
    const root = createTemporaryRoot();
    const plan = createGitForWindowsDownloadPlan({ projectRoot: root, arch });

    expect(gitForWindowsTargets[arch]).toEqual({ archiveName, sha256 });
    expect(plan).toMatchObject({
      arch,
      archiveName,
      sha256,
      sourceUrl: `https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.3/${archiveName}`,
      distributionDir: join(root, 'resources', 'bin', `win32-${arch}`, 'git-for-windows'),
    });
  });

  it('recognizes a complete validated local x64 PortableGit cache', () => {
    const root = createTemporaryRoot();
    writePortableGitLayout(root);
    expect(canReusePortableGitDistribution(root, {
      spawnSync: () => ({ status: 0, stdout: 'git version 2.55.0.windows.3\n' }),
    })).toBe(true);
    expect(canReusePortableGitDistribution(root, {
      spawnSync: () => ({ status: 0, stdout: 'git version 2.54.0.windows.1\n' }),
    })).toBe(false);
  });

  it('accepts exactly one supported architecture option', () => {
    expect(parseGitForWindowsDownloadArgs([])).toEqual({ arch: process.arch, reuseFunctionalLocalCache: false });
    expect(parseGitForWindowsDownloadArgs(['--arch', 'x64'])).toEqual({ arch: 'x64', reuseFunctionalLocalCache: false });
    expect(parseGitForWindowsDownloadArgs(['--arch', 'arm64'])).toEqual({ arch: 'arm64', reuseFunctionalLocalCache: false });
    expect(parseGitForWindowsDownloadArgs(['--arch', 'x64', '--reuse-functional-local-cache'])).toEqual({ arch: 'x64', reuseFunctionalLocalCache: true });

    for (const args of [
      ['--all'],
      ['--arch'],
      ['--arch', 'x64', '--arch', 'arm64'],
      ['--arch', 'x64', 'extra'],
    ]) {
      expect(() => parseGitForWindowsDownloadArgs(args)).toThrow(/usage/);
    }
    expect(() => createGitForWindowsDownloadPlan({ projectRoot: createTemporaryRoot(), arch: 'ia32' })).toThrow(/Unsupported Git for Windows architecture/);
  });

  it.each([
    'bin/bash.exe',
    'cmd/git.exe',
    'usr/bin/bash.exe',
    'usr/bin/msys-2.0.dll',
  ])('rejects a PortableGit distribution missing %s', async (requiredFile) => {
    const root = createTemporaryRoot();
    writePortableGitLayout(root);
    await expect(assertPortableGitLayout(root)).resolves.toBeUndefined();

    rmSync(join(root, requiredFile));
    await expect(assertPortableGitLayout(root)).rejects.toThrow(requiredFile);
  });

  it('removes pseudo-files that make 7-Zip packaging fail', async () => {
    const root = createTemporaryRoot();
    const removed: string[] = [];

    await removePackagingIncompatibleLinks(root, {
      rm: async (path: string) => {
        removed.push(path.slice(root.length + 1));
      },
    });

    expect(removed).toEqual([
      join('dev', 'fd'),
      join('dev', 'stderr'),
      join('dev', 'stdin'),
      join('dev', 'stdout'),
      join('etc', 'mtab'),
    ]);
  });

  it('replaces the previous distribution only after the new one is ready', async () => {
    const root = createTemporaryRoot();
    const distributionDir = join(root, 'git-for-windows');
    const extractedDistribution = join(root, 'staging');
    mkdirSync(distributionDir, { recursive: true });
    writeFileSync(join(distributionDir, 'previous.txt'), 'previous');
    mkdirSync(extractedDistribution, { recursive: true });
    writeFileSync(join(extractedDistribution, 'next.txt'), 'next');

    await publishPortableGitDistribution({ extractedDistribution, distributionDir });

    expect(readdirSync(distributionDir)).toEqual(['next.txt']);
    expect(readdirSync(root)).toEqual(['git-for-windows']);
  });

  it('restores the previous distribution when publication cannot complete', async () => {
    const root = createTemporaryRoot();
    const distributionDir = join(root, 'git-for-windows');
    const extractedDistribution = join(root, 'staging');
    mkdirSync(distributionDir, { recursive: true });
    writeFileSync(join(distributionDir, 'previous.txt'), 'previous');
    mkdirSync(extractedDistribution, { recursive: true });
    writeFileSync(join(extractedDistribution, 'next.txt'), 'next');

    let renameCount = 0;
    const failingFileSystem = {
      rename: async (from: string, to: string) => {
        renameCount += 1;
        if (renameCount === 2) throw Object.assign(new Error('blocked'), { code: 'EPERM' });
        await rename(from, to);
      },
      rm,
    };

    await expect(publishPortableGitDistribution({
      extractedDistribution,
      distributionDir,
      fileSystem: failingFileSystem,
    })).rejects.toThrow('blocked');

    expect(readdirSync(distributionDir)).toEqual(['previous.txt']);
    expect(readdirSync(extractedDistribution)).toEqual(['next.txt']);
  });
});
