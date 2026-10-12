#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');

const RUNTIME_HOST_TARGETS = Object.freeze({
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'win32-x64': 'x86_64-pc-windows-msvc',
});

export function parseRuntimeHostNativeBuildTargetArgs(args) {
  const options = new Map();

  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    if (option !== '--platform' && option !== '--arch' && option !== '--profile') {
      throw new Error(`[build-runtime-host-native] unexpected argument: ${option}`);
    }
    if (options.has(option)) {
      throw new Error(`[build-runtime-host-native] duplicate option: ${option}`);
    }

    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`[build-runtime-host-native] missing value for ${option}`);
    }
    options.set(option, value);
  }

  const platform = options.get('--platform');
  const arch = options.get('--arch');
  if (!platform || !arch) {
    throw new Error('[build-runtime-host-native] required options: --platform <platform> --arch <arch>');
  }

  const profile = options.get('--profile');
  if (profile !== undefined && profile !== 'dev' && profile !== 'release') {
    throw new Error(`[build-runtime-host-native] unsupported profile: ${profile}. Supported profiles: dev, release`);
  }

  return { arch, platform, ...(profile !== undefined ? { profile } : {}) };
}

export function createRuntimeHostNativeBuildPlan({ rootDir: projectRootDir, platform, arch, profile = 'release' }) {
  if (profile !== 'dev' && profile !== 'release') {
    throw new Error(`[build-runtime-host-native] unsupported profile: ${profile}. Supported profiles: dev, release`);
  }

  const targetKey = `${platform}-${arch}`;
  const cargoTarget = RUNTIME_HOST_TARGETS[targetKey];
  if (!cargoTarget) {
    throw new Error(
      `[build-runtime-host-native] unsupported platform/architecture: ${targetKey}. Supported combinations: ${Object.keys(RUNTIME_HOST_TARGETS).join(', ')}`,
    );
  }

  const runtimeHostDir = resolve(projectRootDir ?? rootDir, 'runtime-host');
  const artifactDir = resolve(runtimeHostDir, 'dist', targetKey);
  const targetDir = resolve(runtimeHostDir, 'target');
  const manifestPath = resolve(runtimeHostDir, 'Cargo.toml');
  const binaryName = platform === 'win32' ? 'runtime-host.exe' : 'runtime-host';
  const cargoOutputDir = profile === 'dev' ? 'debug' : 'release';
  const cargoBuildArgs = [
    'build',
    ...(profile === 'release' ? ['--release'] : []),
    '--locked',
    '--manifest-path',
    manifestPath,
    '--target',
    cargoTarget,
    '--target-dir',
    targetDir,
  ];
  const guardian = platform === 'win32'
    ? undefined
    : {
      artifactBinaryPath: resolve(artifactDir, 'runtime-host-guardian'),
      cargoArgs: [...cargoBuildArgs, '--package', 'foundation', '--bin', 'runtime-host-guardian'],
      sourceBinaryPath: resolve(targetDir, cargoTarget, cargoOutputDir, 'runtime-host-guardian'),
    };
  return {
    artifactBinaryPath: resolve(artifactDir, binaryName),
    cargoArgs: [...cargoBuildArgs, '--package', 'runtime-host', '--bin', 'runtime-host'],
    cargoTarget,
    sourceBinaryPath: resolve(targetDir, cargoTarget, cargoOutputDir, binaryName),
    ...(guardian ? { guardian } : {}),
  };
}

export function copyRuntimeHostNativeBinary({ sourceBinaryPath, artifactBinaryPath }, binaryName) {
  if (!existsSync(sourceBinaryPath)) {
    throw new Error(`[build-runtime-host-native] Cargo did not produce ${binaryName}: ${sourceBinaryPath}`);
  }

  mkdirSync(dirname(artifactBinaryPath), { recursive: true });
  copyFileSync(sourceBinaryPath, artifactBinaryPath);
  if (binaryName === 'runtime-host') {
    const obsoleteMcpName = artifactBinaryPath.endsWith('.exe') ? 'runtime-host-mcp.exe' : 'runtime-host-mcp';
    rmSync(join(dirname(artifactBinaryPath), obsoleteMcpName), { force: true });
  }
}

function requirePath(path, label) {
  if (!existsSync(path)) {
    throw new Error(`[build-runtime-host-native] missing ${label}: ${path}`);
  }
}

function createCargoBuildEnv(projectRootDir) {
  const hostKey = `${process.platform}-${process.arch}`;
  const protocName = process.platform === 'win32' ? 'protoc.exe' : 'protoc';
  const protocRoot = resolve(projectRootDir, 'resources', 'bin', 'protoc', hostKey);
  const protocPath = join(protocRoot, 'bin', protocName);
  const protocInclude = join(protocRoot, 'include');
  if (!existsSync(protocPath) || !existsSync(join(protocInclude, 'google', 'protobuf', 'descriptor.proto'))) {
    return process.env;
  }
  return { ...process.env, PROTOC: protocPath, PROTOC_INCLUDE: protocInclude };
}

function buildRuntimeHostNative(target) {
  const plan = createRuntimeHostNativeBuildPlan(target);
  requirePath(resolve(rootDir, 'runtime-host', 'Cargo.toml'), 'Cargo workspace manifest');
  requirePath(resolve(rootDir, 'runtime-host', 'Cargo.lock'), 'Cargo lockfile');
  const artifacts = [
    { binaryName: 'runtime-host', ...plan },
    ...(plan.guardian ? [{ binaryName: 'runtime-host-guardian', ...plan.guardian }] : []),
  ];
  const cargoEnv = createCargoBuildEnv(rootDir);

  for (const artifact of artifacts) {
    console.log(`[build-runtime-host-native] cargo ${artifact.cargoArgs.join(' ')}`);
    const result = spawnSync('cargo', artifact.cargoArgs, {
      cwd: rootDir,
      env: cargoEnv,
      stdio: 'inherit',
    });
    if (result.error) {
      throw new Error(`[build-runtime-host-native] failed to spawn cargo: ${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new Error(`[build-runtime-host-native] cargo build failed with status ${result.status ?? 'unknown'}`);
    }

    copyRuntimeHostNativeBinary(artifact, artifact.binaryName);
    console.log(`[build-runtime-host-native] copied ${artifact.artifactBinaryPath}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    buildRuntimeHostNative(parseRuntimeHostNativeBuildTargetArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
