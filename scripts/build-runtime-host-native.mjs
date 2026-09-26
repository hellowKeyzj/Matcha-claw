#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
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
    if (option !== '--platform' && option !== '--arch') {
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

  return { arch, platform };
}

export function createRuntimeHostNativeBuildPlan({ rootDir: projectRootDir, platform, arch }) {
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
  const cargoBuildArgs = [
    'build',
    '--release',
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
      sourceBinaryPath: resolve(targetDir, cargoTarget, 'release', 'runtime-host-guardian'),
    };
  const mcpBinaryName = platform === 'win32' ? 'runtime-host-mcp.exe' : 'runtime-host-mcp';
  return {
    artifactBinaryPath: resolve(artifactDir, binaryName),
    cargoArgs: [...cargoBuildArgs, '--package', 'runtime-host', '--bin', 'runtime-host'],
    cargoTarget,
    sourceBinaryPath: resolve(targetDir, cargoTarget, 'release', binaryName),
    mcp: {
      artifactBinaryPath: resolve(artifactDir, mcpBinaryName),
      cargoArgs: [...cargoBuildArgs, '--package', 'runtime-host', '--bin', 'runtime-host-mcp'],
      sourceBinaryPath: resolve(targetDir, cargoTarget, 'release', mcpBinaryName),
    },
    ...(guardian ? { guardian } : {}),
  };
}

export function copyRuntimeHostNativeBinary({ sourceBinaryPath, artifactBinaryPath }, binaryName) {
  if (!existsSync(sourceBinaryPath)) {
    throw new Error(`[build-runtime-host-native] Cargo did not produce ${binaryName}: ${sourceBinaryPath}`);
  }

  mkdirSync(dirname(artifactBinaryPath), { recursive: true });
  copyFileSync(sourceBinaryPath, artifactBinaryPath);
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
    { binaryName: 'runtime-host-mcp', ...plan.mcp },
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
