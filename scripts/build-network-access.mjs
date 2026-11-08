#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isNativeExecutable } from '../electron/main/runtime-host-delivery/native-artifact.mjs';
import { prepareNetworkSource } from './prepare-network-source.mjs';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targets = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'win32-x64': 'x86_64-pc-windows-msvc',
};

export function parseNetworkAccessBuildArgs(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    if (!['--platform', '--arch', '--profile', '--artifact-dir'].includes(option)) throw new Error(`Unexpected argument: ${option}`);
    if (options.has(option)) throw new Error(`Duplicate option: ${option}`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${option}`);
    options.set(option, value);
  }
  if (!options.has('--platform') || !options.has('--arch')) {
    throw new Error('Required options: --platform <platform> --arch <arch> [--profile dev|release] [--artifact-dir <path>]');
  }
  return {
    platform: options.get('--platform'), arch: options.get('--arch'), profile: options.get('--profile') ?? 'release',
    artifactDir: options.get('--artifact-dir'),
  };
}

export function createNetworkAccessBuildPlan({ rootDir: projectRootDir = rootDir, platform, arch, profile = 'release', artifactDir }, env = process.env) {
  if (!['dev', 'release'].includes(profile)) throw new Error(`Unsupported profile: ${profile}`);
  const targetKey = `${platform}-${arch}`;
  const cargoTarget = targets[targetKey];
  if (!cargoTarget) throw new Error(`Unsupported platform/architecture: ${targetKey}`);
  const workspaceDir = resolve(projectRootDir, 'network-access');
  const targetDir = env.CARGO_TARGET_DIR ? resolve(workspaceDir, env.CARGO_TARGET_DIR) : join(workspaceDir, 'target');
  const crossCompile = platform !== process.platform || arch !== process.arch;
  const outputDir = join(targetDir, ...(crossCompile ? [cargoTarget] : []), profile === 'dev' ? 'debug' : 'release');
  const binaryName = platform === 'win32' ? 'matcha-network.exe' : 'matcha-network';
  return {
    platform, arch, profile, targetKey, cargoTarget, workspaceDir, binaryName,
    sourceBinaryPath: join(outputDir, binaryName),
    ...(platform === 'win32' ? { packetPath: join(outputDir, 'Packet.dll') } : {}),
    artifactDir: resolve(projectRootDir, artifactDir ?? join('resources', 'bin', targetKey, 'easytier')),
    cargoArgs: [
      'build', ...(profile === 'release' ? ['--release'] : []), '--locked',
      '--manifest-path', join(workspaceDir, 'Cargo.toml'),
      ...(crossCompile ? ['--target', cargoTarget] : []),
      '--target-dir', targetDir, '--bin', 'matcha-network',
    ],
  };
}

async function fileReceipt(path, name) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return { name, size: (await fs.stat(path)).size, sha256: digest.digest('hex') };
}

export async function publishNetworkAccessArtifact(plan) {
  if (!isNativeExecutable(plan.sourceBinaryPath, plan.platform, plan.arch)) {
    throw new Error(`Invalid ${plan.targetKey} matcha-network executable: ${plan.sourceBinaryPath}`);
  }
  const projectRootDir = resolve(plan.workspaceDir, '..');
  const sourceRoot = join(projectRootDir, 'build', 'network-source');
  const source = JSON.parse(await fs.readFile(join(sourceRoot, 'manifest.json'), 'utf8'));
  if (plan.packetPath) {
    const architecture = plan.arch === 'x64' ? 'x86_64' : 'arm64';
    const pinned = join(sourceRoot, 'easytier', 'easytier', 'third_party', architecture, 'Packet.dll');
    if ((await fileReceipt(plan.packetPath)).sha256 !== (await fileReceipt(pinned)).sha256) {
      throw new Error('Cargo Packet.dll does not match the pinned EasyTier source');
    }
  }
  const parent = dirname(plan.artifactDir);
  await fs.mkdir(parent, { recursive: true });
  const staging = await fs.mkdtemp(join(parent, '.matcha-network-'));
  const previous = `${staging}.previous`;
  try {
    const files = [
      [plan.binaryName, plan.sourceBinaryPath],
      ...(plan.packetPath ? [['Packet.dll', plan.packetPath]] : []),
      ['LICENSE', join(sourceRoot, 'easytier', 'LICENSE')],
    ];
    const receipts = [];
    for (const [name, path] of files) {
      const destination = join(staging, name);
      await fs.copyFile(path, destination);
      if (name === plan.binaryName && plan.platform !== 'win32') await fs.chmod(destination, 0o755);
      receipts.push(await fileReceipt(destination, name));
    }
    await fs.writeFile(join(staging, 'manifest.json'), `${JSON.stringify({
      component: 'matcha-network', target: plan.targetKey, profile: plan.profile,
      source,
      lockfile: await fileReceipt(join(plan.workspaceDir, 'Cargo.lock'), 'network-access/Cargo.lock'),
      files: receipts,
      validation: { executableFormat: 'verified', packetSource: plan.packetPath ? 'verified' : 'not-applicable', runtime: 'not-run' },
      notice: 'matcha-network links the fixed EasyTier library (LGPL-3.0); its root LICENSE and pinned source receipt are included. Corresponding source/relinking, dependency licenses and release legal obligations require separate verification.',
    }, null, 2)}\n`, { flag: 'wx' });
    let replaced = false;
    try { await fs.rename(plan.artifactDir, previous); replaced = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await fs.rename(staging, plan.artifactDir); }
    catch (error) {
      if (replaced) await fs.rename(previous, plan.artifactDir);
      throw error;
    }
    if (replaced) await fs.rm(previous, { recursive: true, force: true });
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
  console.log(`[build-network-access] prepared ${plan.artifactDir}; runtime not run`);
}

async function buildNetworkAccess(target) {
  const plan = createNetworkAccessBuildPlan(target);
  for (const name of ['Cargo.toml', 'Cargo.lock']) {
    if (!existsSync(join(plan.workspaceDir, name))) throw new Error(`Missing network-access/${name}`);
  }
  if (process.env.CARGO_BUILD_TARGET) throw new Error('Use --platform/--arch instead of CARGO_BUILD_TARGET');
  await prepareNetworkSource();
  const protocRoot = join(rootDir, 'resources', 'bin', 'protoc', `${process.platform}-${process.arch}`);
  const protoc = join(protocRoot, 'bin', process.platform === 'win32' ? 'protoc.exe' : 'protoc');
  const env = { ...process.env };
  if (!env.PROTOC && existsSync(protoc)) {
    env.PROTOC = protoc;
    env.PROTOC_INCLUDE = join(protocRoot, 'include');
  }
  if (!env.PROTOC || !existsSync(env.PROTOC)) throw new Error('Prepare protoc first: pnpm run protoc:download (or set PROTOC)');
  console.log(`[build-network-access] cargo ${plan.cargoArgs.join(' ')}`);
  const result = spawnSync('cargo', plan.cargoArgs, { cwd: plan.workspaceDir, env, stdio: 'inherit' });
  if (result.error) throw new Error(`Failed to spawn cargo: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Cargo build failed: ${result.status ?? result.signal ?? 'unknown'}`);
  await publishNetworkAccessArtifact(plan);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await buildNetworkAccess(parseNetworkAccessBuildArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(`[build-network-access] ${error.message}`);
    process.exitCode = 1;
  }
}
