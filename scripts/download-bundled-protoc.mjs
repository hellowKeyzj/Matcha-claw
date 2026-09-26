#!/usr/bin/env node

import { createWriteStream, existsSync, promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = '27.2';
const baseUrl = `https://github.com/protocolbuffers/protobuf/releases/download/v${version}`;

const hostTargets = Object.freeze({
  'darwin-arm64': Object.freeze({ archiveName: `protoc-${version}-osx-aarch_64.zip`, binName: 'protoc' }),
  'darwin-x64': Object.freeze({ archiveName: `protoc-${version}-osx-x86_64.zip`, binName: 'protoc' }),
  'linux-arm64': Object.freeze({ archiveName: `protoc-${version}-linux-aarch_64.zip`, binName: 'protoc' }),
  'linux-x64': Object.freeze({ archiveName: `protoc-${version}-linux-x86_64.zip`, binName: 'protoc' }),
  'win32-arm64': Object.freeze({ archiveName: `protoc-${version}-win64.zip`, binName: 'protoc.exe' }),
  'win32-x64': Object.freeze({ archiveName: `protoc-${version}-win64.zip`, binName: 'protoc.exe' }),
});

function hostKey() {
  return `${process.platform}-${process.arch}`;
}

function createPlan(projectRoot = rootDir, key = hostKey()) {
  const target = hostTargets[key];
  if (!target) {
    throw new Error(`[download-bundled-protoc] unsupported host: ${key}`);
  }
  const targetDir = join(projectRoot, 'resources', 'bin', 'protoc', key);
  return {
    key,
    ...target,
    archivePath: join(targetDir, target.archiveName),
    installDir: targetDir,
    sourceUrl: `${baseUrl}/${target.archiveName}`,
    stagingDir: `${targetDir}.staging-${process.pid}`,
  };
}

async function downloadToFile(sourceUrl, destination) {
  const response = await fetch(sourceUrl);
  if (!response.ok || !response.body) {
    throw new Error(`[download-bundled-protoc] download failed: ${response.status} ${response.statusText}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination, { flags: 'w' }));
}

async function extractZip(archivePath, destination) {
  if (process.platform === 'win32') {
    const command = `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory('${archivePath.replace(/'/g, "''")}', '${destination.replace(/'/g, "''")}')`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`[download-bundled-protoc] extraction failed with status ${result.status ?? 'unknown'}`);
    return;
  }
  const result = spawnSync('unzip', ['-q', '-o', archivePath, '-d', destination], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`[download-bundled-protoc] extraction failed with status ${result.status ?? 'unknown'}`);
}

async function assertProtocLayout(plan, root = plan.installDir) {
  const protoc = join(root, 'bin', plan.binName);
  const descriptor = join(root, 'include', 'google', 'protobuf', 'descriptor.proto');
  if (!existsSync(protoc) || !existsSync(descriptor)) {
    throw new Error('[download-bundled-protoc] archive has an unexpected layout');
  }
}

async function writeNotice(plan) {
  await fs.writeFile(
    join(plan.installDir, 'MATCHACLAW-NOTICE.txt'),
    [
      `Protocol Buffers protoc ${version} (${plan.key})`,
      `Source: ${plan.sourceUrl}`,
      '',
      'Bundled for Rust build scripts that require a host protoc binary.',
      'Upstream license notices are preserved in the archive payload.',
      '',
    ].join('\n'),
    'utf8',
  );
}

async function setupProtoc(plan) {
  if (existsSync(join(plan.installDir, 'bin', plan.binName)) && existsSync(join(plan.installDir, 'include', 'google', 'protobuf', 'descriptor.proto'))) {
    console.log(`[download-bundled-protoc] ready: ${plan.installDir}`);
    return;
  }

  await fs.mkdir(dirname(plan.archivePath), { recursive: true });
  await fs.rm(plan.stagingDir, { recursive: true, force: true });
  try {
    console.log(`[download-bundled-protoc] downloading ${plan.sourceUrl}`);
    await downloadToFile(plan.sourceUrl, plan.archivePath);
    await fs.mkdir(plan.stagingDir, { recursive: true });
    await extractZip(plan.archivePath, plan.stagingDir);
    await assertProtocLayout(plan, plan.stagingDir);
    await fs.rm(plan.installDir, { recursive: true, force: true });
    await fs.rename(plan.stagingDir, plan.installDir);
    if (process.platform !== 'win32') {
      await fs.chmod(join(plan.installDir, 'bin', plan.binName), 0o755);
    }
    await writeNotice(plan);
    console.log(`[download-bundled-protoc] ready: ${plan.installDir}`);
  } finally {
    await fs.rm(plan.archivePath, { force: true });
    await fs.rm(plan.stagingDir, { recursive: true, force: true });
  }
}

try {
  await setupProtoc(createPlan());
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
