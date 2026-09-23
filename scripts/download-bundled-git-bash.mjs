#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseTag = 'v2.55.0.windows.3';
const version = '2.55.0.3';
const releaseBaseUrl = `https://github.com/git-for-windows/git/releases/download/${releaseTag}`;

export const gitForWindowsTargets = Object.freeze({
  x64: Object.freeze({
    archiveName: `Git-${version}-64-bit.tar.bz2`,
    sha256: '4ee071816e424f928f493c4b42e5486d05344a371665c82f1802ebcecaa1d19a',
  }),
  arm64: Object.freeze({
    archiveName: `Git-${version}-arm64.tar.bz2`,
    sha256: 'ff753aa49b9baeafda33470128ee799b19e48b06736d3c555585bc926dc13b2d',
  }),
});

const requiredDistributionFiles = Object.freeze([
  'bin/bash.exe',
  'cmd/git.exe',
  'usr/bin/bash.exe',
  'usr/bin/msys-2.0.dll',
]);

const packagingIncompatibleLinkPaths = Object.freeze([
  'dev/fd',
  'dev/stderr',
  'dev/stdin',
  'dev/stdout',
  'etc/mtab',
]);

export function parseGitForWindowsDownloadArgs(args) {
  if (args.length === 0) return { arch: process.arch, reuseFunctionalLocalCache: false };
  if (args.length !== 2 && args.length !== 3) {
    throw new Error('usage: download-bundled-git-bash.mjs [--arch <x64|arm64>] [--reuse-functional-local-cache]');
  }
  if (args[0] !== '--arch' || (args.length === 3 && args[2] !== '--reuse-functional-local-cache')) {
    throw new Error('usage: download-bundled-git-bash.mjs [--arch <x64|arm64>] [--reuse-functional-local-cache]');
  }
  return { arch: args[1], reuseFunctionalLocalCache: args.length === 3 };
}

export function createGitForWindowsDownloadPlan({ projectRoot = rootDir, arch, reuseFunctionalLocalCache = false }) {
  const target = gitForWindowsTargets[arch];
  if (!target) {
    throw new Error(`Unsupported Git for Windows architecture: ${arch}. Supported: ${Object.keys(gitForWindowsTargets).join(', ')}`);
  }
  const targetDir = join(projectRoot, 'resources', 'bin', `win32-${arch}`);
  return {
    arch,
    archiveName: target.archiveName,
    archivePath: join(targetDir, target.archiveName),
    distributionDir: join(targetDir, 'git-for-windows'),
    sha256: target.sha256,
    sourceUrl: `${releaseBaseUrl}/${target.archiveName}`,
    reuseFunctionalLocalCache,
  };
}

export async function assertPortableGitLayout(distributionDir, pathExists = existsSync) {
  for (const relativePath of requiredDistributionFiles) {
    if (!pathExists(join(distributionDir, relativePath))) {
      throw new Error(`PortableGit distribution is missing required file: ${relativePath}`);
    }
  }
}

export function canReusePortableGitDistribution(distributionDir, dependencies = {}) {
  const pathExists = dependencies.existsSync ?? existsSync;
  const execute = dependencies.spawnSync ?? spawnSync;
  if (!requiredDistributionFiles.every((relativePath) => pathExists(join(distributionDir, relativePath)))) return false;
  const gitPath = join(distributionDir, 'cmd', 'git.exe');
  const result = execute(gitPath, ['--version'], { encoding: 'utf8', timeout: 5_000, windowsHide: true });
  return !result.error && result.status === 0 && String(result.stdout ?? '').trim() === `git version ${releaseTag.slice(1)}`;
}

async function downloadToFile(sourceUrl, destination) {
  const response = await fetch(sourceUrl);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download Git for Windows: ${response.status} ${response.statusText}`);
  }

  const hash = createHash('sha256');
  await pipeline(
    Readable.fromWeb(response.body),
    new Transform({
      transform(chunk, encoding, callback) {
        hash.update(chunk);
        callback(null, chunk);
      },
    }),
    createWriteStream(destination, { flags: 'w' }),
  );
  return hash.digest('hex');
}

async function extractGitForWindows(archivePath, destination) {
  const windowsTar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  await new Promise((resolveExtract, rejectExtract) => {
    const child = spawn(windowsTar, ['-xjf', archivePath, '-C', destination], {
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', rejectExtract);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolveExtract(undefined);
        return;
      }
      rejectExtract(new Error(`Git for Windows extraction failed with ${signal ?? `exit code ${String(code)}`}`));
    });
  });
}

async function resolveExtractedDistribution(stagingDir) {
  try {
    await assertPortableGitLayout(stagingDir);
    return stagingDir;
  } catch {
    const entries = await fs.readdir(stagingDir, { withFileTypes: true });
    const directories = entries.filter((entry) => entry.isDirectory());
    if (entries.length !== 1 || directories.length !== 1) {
      throw new Error('Git for Windows archive has an unexpected root layout.');
    }
    const distributionDir = join(stagingDir, directories[0].name);
    await assertPortableGitLayout(distributionDir);
    return distributionDir;
  }
}

export async function removePackagingIncompatibleLinks(distributionDir, fileSystem = fs) {
  for (const relativePath of packagingIncompatibleLinkPaths) {
    await fileSystem.rm(join(distributionDir, relativePath), { force: true });
  }
}

async function writeDistributionNotice(distributionDir, plan) {
  const notice = [
    `Git for Windows ${version} (${plan.arch})`,
    `Source: ${plan.sourceUrl}`,
    `SHA-256: ${plan.sha256}`,
    '',
    'This complete Git for Windows distribution is bundled for its Git Bash/MSYS runtime.',
    'Upstream license notices are preserved in the bundled distribution.',
    'MatchaClaw redistribution notes are in resources/licenses/GIT_FOR_WINDOWS-2.55.0.3.txt.',
    '',
  ].join('\n');
  await fs.writeFile(join(distributionDir, 'MATCHACLAW-NOTICE.txt'), notice, 'utf8');
}

export async function publishPortableGitDistribution({
  extractedDistribution,
  distributionDir,
  fileSystem = fs,
}) {
  const backupDir = `${distributionDir}.previous-${process.pid}`;
  let hasBackup = false;

  try {
    await fileSystem.rename(distributionDir, backupDir);
    hasBackup = true;
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
  }

  try {
    await fileSystem.rename(extractedDistribution, distributionDir);
  } catch (error) {
    if (hasBackup) {
      await fileSystem.rename(backupDir, distributionDir);
    }
    throw error;
  }

  if (hasBackup) {
    await fileSystem.rm(backupDir, { recursive: true, force: true });
  }
}

export async function downloadGitForWindows(plan) {
  if (process.platform !== 'win32') {
    throw new Error('Git for Windows artifacts must be extracted on a Windows build host.');
  }

  if (plan.reuseFunctionalLocalCache && plan.arch === 'x64' && canReusePortableGitDistribution(plan.distributionDir)) {
    await removePackagingIncompatibleLinks(plan.distributionDir);
    console.log(`[download-bundled-git-bash] using existing validated PortableGit distribution: ${plan.distributionDir}`);
    return;
  }

  const targetDir = dirname(plan.distributionDir);
  const stagingDir = `${plan.distributionDir}.staging-${process.pid}`;
  await fs.mkdir(targetDir, { recursive: true });
  await fs.rm(stagingDir, { recursive: true, force: true });

  try {
    const digest = await downloadToFile(plan.sourceUrl, plan.archivePath);
    if (digest !== plan.sha256) {
      throw new Error(`Git for Windows checksum mismatch for ${plan.archiveName}.`);
    }
    await fs.mkdir(stagingDir, { recursive: true });
    await extractGitForWindows(plan.archivePath, stagingDir);
    const extractedDistribution = await resolveExtractedDistribution(stagingDir);
    await removePackagingIncompatibleLinks(extractedDistribution);
    await writeDistributionNotice(extractedDistribution, plan);
    await publishPortableGitDistribution({
      extractedDistribution,
      distributionDir: plan.distributionDir,
    });
  } finally {
    await fs.rm(plan.archivePath, { force: true });
    await fs.rm(stagingDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const plan = createGitForWindowsDownloadPlan(parseGitForWindowsDownloadArgs(process.argv.slice(2)));
    await downloadGitForWindows(plan);
    console.log(`[download-bundled-git-bash] ready: ${plan.distributionDir}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
