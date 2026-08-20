#!/usr/bin/env node

import { existsSync, lstatSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { localFunctionalBunCacheEvidence } from './download-bundled-bun.mjs';
import { localFunctionalUvCacheEvidence } from './download-bundled-uv.mjs';
import {
  createRuntimeHostPackageSmokePlan,
  runRuntimeHostPackageSmoke,
} from './package-smoke-runtime-host.mjs';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WINDOWS_X64_BUN_CACHE = join(ROOT_DIR, 'resources', 'bin', 'win32-x64', 'bun.exe');
const WINDOWS_X64_UV_CACHE = join(ROOT_DIR, 'resources', 'bin', 'win32-x64', 'uv.exe');

function proofError(message) {
  return new Error(`[prove-windows-x64-package] ${message}`);
}

export function parseWindowsX64PackageProofArgs(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    if (option === '--reuse-functional-local-bun-cache' || option === '--reuse-functional-local-uv-cache') {
      if (options.has(option)) throw proofError(`duplicate option: ${option}`);
      options.set(option, true);
      index -= 1;
      continue;
    }
    if (!['--unpacked', '--package', '--installed', '--receipt', '--source-revision'].includes(option)) {
      throw proofError(`unexpected argument: ${option}`);
    }
    if (options.has(option)) throw proofError(`duplicate option: ${option}`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw proofError(`missing value for ${option}`);
    options.set(option, value);
  }

  const unpackedArtifactPath = options.get('--unpacked');
  const packageArtifactPath = options.get('--package');
  const installedArtifactPath = options.get('--installed');
  const receiptPath = options.get('--receipt');
  const sourceRevision = options.get('--source-revision');
  if (!unpackedArtifactPath || !packageArtifactPath || !installedArtifactPath || !receiptPath || !sourceRevision) {
    throw proofError('required options: --unpacked <path> --package <path> --installed <path> --receipt <path> --source-revision <sha>');
  }
  if (!/^[a-f0-9]{40,64}$/i.test(sourceRevision)) {
    throw proofError('--source-revision must be a 40-64 character hexadecimal revision');
  }
  for (const [label, value] of Object.entries({ unpackedArtifactPath, packageArtifactPath, installedArtifactPath, receiptPath })) {
    if (!isAbsolute(value)) throw proofError(`--${label.replace('ArtifactPath', '').replace('Path', '')} must be absolute`);
  }
  return {
    unpackedArtifactPath: resolve(unpackedArtifactPath),
    packageArtifactPath: resolve(packageArtifactPath),
    installedArtifactPath: resolve(installedArtifactPath),
    receiptPath: resolve(receiptPath),
    sourceRevision: sourceRevision.toLowerCase(),
    reuseFunctionalLocalBunCache: options.has('--reuse-functional-local-bun-cache'),
    reuseFunctionalLocalUvCache: options.has('--reuse-functional-local-uv-cache'),
  };
}

export function createWindowsX64PackageProofPlan(input) {
  if (process.platform !== 'win32') {
    throw proofError(`requires a Windows x64 host; got ${process.platform}/${process.arch}`);
  }
  if (process.arch !== 'x64') {
    throw proofError(`requires a Windows x64 host; got ${process.platform}/${process.arch}`);
  }
  if (!existsSync(input.unpackedArtifactPath) || !lstatSync(input.unpackedArtifactPath).isDirectory()) {
    throw proofError(`unpacked artifact is not a directory: ${input.unpackedArtifactPath}`);
  }
  if (!existsSync(input.packageArtifactPath) || !lstatSync(input.packageArtifactPath).isFile()) {
    throw proofError(`NSIS package artifact is not a file: ${input.packageArtifactPath}`);
  }
  if (existsSync(input.installedArtifactPath)) {
    throw proofError(`installed root must not exist before NSIS installation: ${input.installedArtifactPath}`);
  }
  if (existsSync(input.receiptPath)) {
    throw proofError(`local receipt path must not already exist: ${input.receiptPath}`);
  }
  return input;
}

export function runWindowsX64PackageProof(plan, dependencies = {}) {
  const spawn = dependencies.spawnSync ?? spawnSync;
  const startedAt = performance.now();
  const installation = spawn(plan.packageArtifactPath, ['/S', `/D=${plan.installedArtifactPath}`], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const durationMs = Math.floor(performance.now() - startedAt);
  if (installation.error || installation.status !== 0) {
    throw proofError(`NSIS installation failed with ${installation.error?.message ?? `exit code ${String(installation.status)}`}`);
  }
  if (!existsSync(plan.installedArtifactPath) || !lstatSync(plan.installedArtifactPath).isDirectory()) {
    throw proofError(`NSIS installer did not create the requested installed root: ${plan.installedArtifactPath}`);
  }

  const bunCacheEvidence = plan.reuseFunctionalLocalBunCache
    ? localFunctionalBunCacheEvidence({ executablePath: WINDOWS_X64_BUN_CACHE, targetId: 'win32-x64' })
    : undefined;
  if (plan.reuseFunctionalLocalBunCache && !bunCacheEvidence) {
    throw proofError(`functional local Bun cache does not match the pinned Windows x64 target: ${WINDOWS_X64_BUN_CACHE}`);
  }
  const uvCacheEvidence = plan.reuseFunctionalLocalUvCache
    ? localFunctionalUvCacheEvidence({ executablePath: WINDOWS_X64_UV_CACHE, targetId: 'win32-x64' })
    : undefined;
  if (plan.reuseFunctionalLocalUvCache && !uvCacheEvidence) {
    throw proofError(`functional local uv cache does not match the pinned Windows x64 target: ${WINDOWS_X64_UV_CACHE}`);
  }

  const smokePlan = createRuntimeHostPackageSmokePlan({
    platform: 'win32',
    arch: 'x64',
    target: 'nsis',
    unpackedArtifactPath: plan.unpackedArtifactPath,
    packageArtifactPath: plan.packageArtifactPath,
    installedArtifactPath: plan.installedArtifactPath,
    localReceiptPath: plan.receiptPath,
    sourceRevision: plan.sourceRevision,
    ...(bunCacheEvidence ? { bunCacheEvidence } : {}),
    ...(uvCacheEvidence ? { uvCacheEvidence } : {}),
    installation: {
      scenario: 'fresh-silent-temporary-root',
      clock: 'monotonic',
      startBoundary: 'immediately-before-nsis-process-invocation',
      endBoundary: 'immediately-after-nsis-process-return',
      durationMs,
      exitCode: 0,
    },
    runNative: true,
  });
  const smoke = runRuntimeHostPackageSmoke(smokePlan, dependencies);
  return { ...smoke, receiptPath: plan.receiptPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const proof = runWindowsX64PackageProof(createWindowsX64PackageProofPlan(parseWindowsX64PackageProofArgs(process.argv.slice(2))));
    console.log(proof.report);
    console.log(`local-receipt=${proof.receiptPath}`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
