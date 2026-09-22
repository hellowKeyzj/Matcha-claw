#!/usr/bin/env node

import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
const LEGACY_ENTRY_NAMES = new Set(['main-cli.js', 'host-process.cjs']);
const EXECUTION_TIMEOUT_MS = 5_000;
const EVIDENCE_MANIFEST_VERSION = 2;
const EVIDENCE_RECEIPT_VERSION = 1;
const WINDOWS_NSIS_INSTALLATION = Object.freeze({
  scenario: 'fresh-silent-temporary-root',
  clock: 'monotonic',
  startBoundary: 'immediately-before-nsis-process-invocation',
  endBoundary: 'immediately-after-nsis-process-return',
});

export const PACKAGE_SMOKE_CELLS = Object.freeze([
  { platform: 'darwin', arch: 'x64', target: 'dmg' },
  { platform: 'darwin', arch: 'arm64', target: 'dmg' },
  { platform: 'darwin', arch: 'x64', target: 'zip' },
  { platform: 'darwin', arch: 'arm64', target: 'zip' },
  { platform: 'win32', arch: 'x64', target: 'nsis' },
  { platform: 'win32', arch: 'arm64', target: 'nsis' },
  { platform: 'linux', arch: 'x64', target: 'AppImage' },
  { platform: 'linux', arch: 'arm64', target: 'AppImage' },
  { platform: 'linux', arch: 'x64', target: 'deb' },
  { platform: 'linux', arch: 'arm64', target: 'deb' },
  { platform: 'linux', arch: 'x64', target: 'rpm' },
]);

function packageSmokeError(message) {
  return new Error(`[package-smoke-runtime-host] ${message}`);
}

export function parseRuntimeHostPackageSmokeArgs(args) {
  const options = new Map();
  let runNative = false;

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === '--run') {
      if (runNative) throw packageSmokeError('duplicate option: --run');
      runNative = true;
      continue;
    }
    if (![
      '--platform',
      '--arch',
      '--target',
      '--unpacked',
      '--package',
      '--installed',
      '--receipt',
      '--local-receipt',
      '--repository',
      '--workflow-ref',
      '--source-revision',
      '--run-id',
      '--run-attempt',
      '--nsis-install-duration-ms',
      '--nsis-install-exit-code',
    ].includes(option)) {
      throw packageSmokeError(`unexpected argument: ${option}`);
    }
    if (options.has(option)) throw packageSmokeError(`duplicate option: ${option}`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw packageSmokeError(`missing value for ${option}`);
    options.set(option, value);
    index += 1;
  }

  const platform = options.get('--platform');
  const arch = options.get('--arch');
  const target = options.get('--target');
  const unpackedArtifactPath = options.get('--unpacked');
  const packageArtifactPath = options.get('--package');
  const installedArtifactPath = options.get('--installed');
  const receiptPath = options.get('--receipt');
  const localReceiptPath = options.get('--local-receipt');
  const repository = options.get('--repository');
  const workflowRef = options.get('--workflow-ref');
  const sourceRevision = options.get('--source-revision');
  const runId = options.get('--run-id');
  const runAttempt = options.get('--run-attempt');
  const nsisInstallDurationMs = options.get('--nsis-install-duration-ms');
  const nsisInstallExitCode = options.get('--nsis-install-exit-code');
  const isWindowsNsisReceipt = Boolean((receiptPath || localReceiptPath) && platform === 'win32' && (arch === 'x64' || arch === 'arm64') && target === 'nsis');
  const hasNsisInstallationEvidence = Boolean(nsisInstallDurationMs || nsisInstallExitCode);
  if (!platform || !arch || !target || !unpackedArtifactPath) {
    throw packageSmokeError('required options: --platform <platform> --arch <arch> --target <target> --unpacked <path>');
  }
  if (installedArtifactPath && !packageArtifactPath) {
    throw packageSmokeError('--installed requires --package');
  }
  if (receiptPath && localReceiptPath) {
    throw packageSmokeError('--receipt and --local-receipt are mutually exclusive');
  }
  const provenanceValues = [repository, workflowRef, sourceRevision, runId, runAttempt];
  if (!localReceiptPath && provenanceValues.some(Boolean) && provenanceValues.some((value) => !value)) {
    throw packageSmokeError('receipt provenance requires --repository --workflow-ref --source-revision --run-id --run-attempt');
  }
  if (receiptPath && provenanceValues.some((value) => !value)) {
    throw packageSmokeError('--receipt requires complete receipt provenance');
  }
  if (localReceiptPath && (repository || workflowRef || runId || runAttempt || !sourceRevision)) {
    throw packageSmokeError('--local-receipt requires --source-revision only, without CI provenance');
  }
  if (localReceiptPath && !/^[a-f0-9]{40,64}$/i.test(sourceRevision)) {
    throw packageSmokeError('--local-receipt source revision is invalid');
  }
  if (receiptPath && (!runNative || !packageArtifactPath || !installedArtifactPath)) {
    throw packageSmokeError('--receipt requires --run, --package, and --installed');
  }
  if (localReceiptPath && (!runNative || !packageArtifactPath || !installedArtifactPath)) {
    throw packageSmokeError('--local-receipt requires --run, --package, and --installed');
  }
  if (isWindowsNsisReceipt && !hasNsisInstallationEvidence) {
    throw packageSmokeError('Windows NSIS receipts require --nsis-install-duration-ms and --nsis-install-exit-code');
  }
  if (!isWindowsNsisReceipt && hasNsisInstallationEvidence) {
    throw packageSmokeError('NSIS installation evidence is only valid for Windows NSIS receipts');
  }
  const installation = isWindowsNsisReceipt
    ? parseWindowsNsisInstallationEvidence(nsisInstallDurationMs, nsisInstallExitCode)
    : undefined;

  return {
    platform,
    arch,
    target,
    unpackedArtifactPath,
    ...(packageArtifactPath ? { packageArtifactPath } : {}),
    ...(installedArtifactPath ? { installedArtifactPath } : {}),
    ...(receiptPath ? { receiptPath } : {}),
    ...(localReceiptPath ? { localReceiptPath, sourceRevision } : {}),
    ...(repository ? {
      provenance: {
        repository,
        workflowRef,
        sourceRevision,
        runId,
        runAttempt,
      },
    } : {}),
    ...(installation ? { installation } : {}),
    runNative,
  };
}

export function createRuntimeHostPackageSmokePlan(input) {
  const platform = input.platform;
  const arch = input.arch;
  const target = input.target;
  if (!PACKAGE_SMOKE_CELLS.some((cell) => cell.platform === platform && cell.arch === arch && cell.target === target)) {
    throw packageSmokeError(`package cell ${platform}-${arch} × ${target} is not declared by electron-builder`);
  }

  const unpackedArtifactPath = resolve(input.unpackedArtifactPath);
  const packageArtifactPath = input.packageArtifactPath
    ? resolve(input.packageArtifactPath)
    : undefined;
  const targetKey = `${platform}-${arch}`;
  const hostPlatform = input.hostPlatform ?? process.platform;
  const hostArch = input.hostArch ?? process.arch;
  const execution = input.runNative
    ? (hostPlatform === platform && hostArch === arch ? 'native-run' : 'cross-build')
    : 'uncovered';
  if (input.receiptPath && platform === 'win32' && target === 'nsis' && execution !== 'native-run') {
    throw packageSmokeError('Windows NSIS receipts require a native Windows package run');
  }
  const unpackedLayout = runtimeHostLayout(unpackedArtifactPath, platform, targetKey);
  const installedArtifactPath = input.installedArtifactPath
    ? resolve(input.installedArtifactPath)
    : undefined;
  if (
    installedArtifactPath &&
    (isSameOrDescendant(unpackedArtifactPath, installedArtifactPath) || isSameOrDescendant(installedArtifactPath, unpackedArtifactPath))
  ) {
    throw packageSmokeError('--installed must be a separate application root produced by package installation, mounting, or extraction');
  }
  if (packageArtifactPath && (
    isSameOrDescendant(unpackedArtifactPath, packageArtifactPath) ||
    (installedArtifactPath && isSameOrDescendant(installedArtifactPath, packageArtifactPath))
  )) {
    throw packageSmokeError('--package must be outside the unpacked and installed application roots');
  }
  const installedLayout = installedArtifactPath
    ? runtimeHostLayout(installedArtifactPath, platform, targetKey)
    : undefined;
  const packageExecution = installedLayout
    ? execution === 'native-run' ? 'installed-native-run' : execution
    : input.packageArtifactPath ? 'uncovered-not-run' : 'uncovered-no-package-artifact';

  return {
    platform,
    arch,
    target,
    unpackedArtifactPath,
    ...(packageArtifactPath ? { packageArtifactPath } : {}),
    ...(installedArtifactPath ? { installedArtifactPath } : {}),
    ...(input.receiptPath ? { receiptPath: resolve(input.receiptPath) } : {}),
    ...(input.localReceiptPath ? { localReceiptPath: resolve(input.localReceiptPath), localSourceRevision: input.sourceRevision.toLowerCase() } : {}),
    ...(input.bunCacheEvidence ? { bunCacheEvidence: input.bunCacheEvidence } : {}),
    ...(input.uvCacheEvidence ? { uvCacheEvidence: input.uvCacheEvidence } : {}),
    ...(input.provenance ? { provenance: input.provenance } : {}),
    ...(input.installation ? { installation: input.installation } : {}),
    ...unpackedLayout,
    ...(installedLayout ? { installed: installedLayout } : {}),
    targetKey,
    execution,
    packageExecution,
  };
}

function isSameOrDescendant(root, candidate) {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

function runtimeHostLayout(applicationRoot, platform, targetKey) {
  const resourcesPath = platform === 'darwin'
    ? join(applicationRoot, 'Contents', 'Resources')
    : join(applicationRoot, 'resources');
  const runtimeHostDirectory = join(resourcesPath, 'bin', targetKey);
  return {
    applicationRoot,
    platform,
    resourcesPath,
    runtimeHostDirectory,
    bunPath: join(resourcesPath, 'bin', platform === 'win32' ? 'bun.exe' : 'bun'),
    runtimeHostPath: join(runtimeHostDirectory, platform === 'win32' ? 'runtime-host.exe' : 'runtime-host'),
    runtimeHostMcpPath: join(runtimeHostDirectory, platform === 'win32' ? 'runtime-host-mcp.exe' : 'runtime-host-mcp'),
    guardianPath: join(runtimeHostDirectory, 'runtime-host-guardian'),
  };
}

export function inspectRuntimeHostPackageInventory(plan, dependencies = {}) {
  const isFile = dependencies.isFile ?? defaultIsFile;
  const readDirectory = dependencies.readDirectory ?? defaultReadDirectory;
  const isDirectory = dependencies.isDirectory ?? defaultIsDirectory;
  inspectRuntimeHostLayout(plan, dependencies, 'unpacked');
  if (plan.packageArtifactPath && !isFile(plan.packageArtifactPath)) {
    throw packageSmokeError(`missing package artifact: ${plan.packageArtifactPath}`);
  }
  if (plan.installed) {
    inspectRuntimeHostLayout(plan.installed, dependencies, 'installed');
  }

  return {
    bun: 'present',
    runtimeHost: 'present',
    runtimeHostMcp: 'present',
    guardian: plan.platform === 'win32' ? 'not-applicable' : 'present',
    packageArtifact: plan.packageArtifactPath ? 'present' : 'not-provided',
    installedApplication: plan.installed ? 'present' : 'not-provided',
  };
}

function inspectRuntimeHostLayout(layout, dependencies, label) {
  const isFile = dependencies.isFile ?? defaultIsFile;
  const readDirectory = dependencies.readDirectory ?? defaultReadDirectory;
  const isDirectory = dependencies.isDirectory ?? defaultIsDirectory;
  if (!isDirectory(layout.applicationRoot)) {
    throw packageSmokeError(`${label} application root is not a directory: ${layout.applicationRoot}`);
  }
  if (!isDirectory(layout.resourcesPath)) {
    throw packageSmokeError(`${label} resources root is not a directory: ${layout.resourcesPath}`);
  }
  if (!isDirectory(layout.runtimeHostDirectory)) {
    throw packageSmokeError(`${label} runtime-host directory is not a directory: ${layout.runtimeHostDirectory}`);
  }
  if (!isFile(layout.runtimeHostPath)) {
    throw packageSmokeError(`missing ${label} runtime-host artifact: ${layout.runtimeHostPath}`);
  }
  if (!isFile(layout.runtimeHostMcpPath)) {
    throw packageSmokeError(`missing ${label} runtime-host-mcp artifact: ${layout.runtimeHostMcpPath}`);
  }
  if (!isFile(layout.bunPath)) {
    throw packageSmokeError(`missing ${label} Bun artifact: ${layout.bunPath}`);
  }
  if (layout.platform === 'win32') {
    if (isFile(layout.guardianPath)) {
      throw packageSmokeError(`unexpected runtime-host-guardian in Windows artifact: ${layout.guardianPath}`);
    }
  } else if (!isFile(layout.guardianPath)) {
    throw packageSmokeError(`missing ${label} runtime-host-guardian artifact: ${layout.guardianPath}`);
  }

  const legacyEntry = findLegacyEntry(layout.resourcesPath, readDirectory, isDirectory);
  if (legacyEntry) {
    throw packageSmokeError(`legacy packaged entry is forbidden: ${legacyEntry}`);
  }
  const asarEntry = findLegacyAsarEntry(join(layout.resourcesPath, 'app.asar'), dependencies.readAsarHeader ?? readAsarHeader);
  if (asarEntry) {
    throw packageSmokeError(`legacy packaged entry is forbidden: app.asar/${asarEntry}`);
  }
}

export function runRuntimeHostPackageSmoke(plan, dependencies = {}) {
  const inventory = inspectRuntimeHostPackageInventory(plan, dependencies);
  const spawnSync = dependencies.spawnSync ?? nodeSpawnSync;
  const executionDetail = runBootstrapRejection(plan.runtimeHostPath, plan.execution, spawnSync);
  const packageExecutionDetail = plan.installed
    ? runBootstrapRejection(plan.installed.runtimeHostPath, plan.packageExecution, spawnSync)
    : plan.packageArtifactPath ? 'not-run-no-installed-application' : 'not-provided';
  const result = {
    execution: plan.execution,
    executionDetail,
    inventory: 'passed-not-execution',
    packageExecution: plan.packageExecution,
    packageExecutionDetail,
  };
  if (plan.receiptPath) {
    const receipt = createRuntimeHostPackageExecutionReceipt(plan, result, plan.provenance, dependencies);
    verifyRuntimeHostPackageExecutionReceipt(plan, receipt, dependencies);
    result.receiptPath = writeRuntimeHostPackageExecutionReceipt(plan.receiptPath, receipt, dependencies);
  }
  if (plan.localReceiptPath) {
    const receipt = createRuntimeHostLocalPackageExecutionReceipt(plan, result, dependencies);
    verifyRuntimeHostLocalPackageExecutionReceipt(plan, receipt, dependencies);
    result.localReceiptPath = writeRuntimeHostLocalPackageExecutionReceipt(plan.localReceiptPath, receipt, dependencies);
  }

  const inventoryDetail = `bun=${inventory.bun}; runtime-host=${inventory.runtimeHost}; runtime-host-mcp=${inventory.runtimeHostMcp}; guardian=${inventory.guardian}; package=${inventory.packageArtifact}; installed=${inventory.installedApplication}`;
  const report = [
    `cell=${plan.platform}-${plan.arch} × ${plan.target}`,
    `inventory=passed-not-execution (${inventoryDetail})`,
    `runtime-host-execution=${plan.execution} (${executionDetail})`,
    `package-execution=${plan.packageExecution} (${packageExecutionDetail})`,
  ].join('\n');
  return { ...result, report };
}

function runBootstrapRejection(runtimeHostPath, execution, spawnSync) {
  if (execution !== 'native-run' && execution !== 'installed-native-run') {
    return execution === 'cross-build' ? 'not-run-on-host' : 'not-requested';
  }
  const result = spawnSync(runtimeHostPath, [], {
    encoding: 'utf8',
    input: '',
    timeout: EXECUTION_TIMEOUT_MS,
    windowsHide: true,
  });
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  if (result.error || result.status !== 1 || !isBootstrapRejection(stderr)) {
    throw packageSmokeError('native runtime-host bootstrap-rejection smoke failed');
  }
  return 'bootstrap-rejection-passed';
}

function parseWindowsNsisInstallationEvidence(durationMs, exitCode) {
  if (!/^(0|[1-9]\d*)$/.test(durationMs ?? '')) {
    throw packageSmokeError('--nsis-install-duration-ms must be a nonnegative safe integer');
  }
  const parsedDurationMs = Number(durationMs);
  if (!Number.isSafeInteger(parsedDurationMs)) {
    throw packageSmokeError('--nsis-install-duration-ms must be a nonnegative safe integer');
  }
  if (exitCode !== '0') {
    throw packageSmokeError('--nsis-install-exit-code must be 0');
  }
  return { ...WINDOWS_NSIS_INSTALLATION, durationMs: parsedDurationMs, exitCode: 0 };
}

function requireWindowsNsisInstallation(value) {
  const installation = requireExactRecord(value, [
    'scenario',
    'clock',
    'startBoundary',
    'endBoundary',
    'durationMs',
    'exitCode',
  ], 'receipt installation');
  if (
    installation.scenario !== WINDOWS_NSIS_INSTALLATION.scenario ||
    installation.clock !== WINDOWS_NSIS_INSTALLATION.clock ||
    installation.startBoundary !== WINDOWS_NSIS_INSTALLATION.startBoundary ||
    installation.endBoundary !== WINDOWS_NSIS_INSTALLATION.endBoundary ||
    !Number.isSafeInteger(installation.durationMs) || installation.durationMs < 0 ||
    installation.exitCode !== 0
  ) {
    throw packageSmokeError('receipt installation is invalid');
  }
  return installation;
}

function requireReceiptProvenance(value) {
  if (!value || typeof value !== 'object') {
    throw packageSmokeError('receipt provenance is required');
  }
  const { repository, workflowRef, sourceRevision, runId, runAttempt } = value;
  if (
    typeof repository !== 'string' || repository.trim() === '' ||
    typeof workflowRef !== 'string' || workflowRef.trim() === '' ||
    typeof sourceRevision !== 'string' || !/^[a-f0-9]{40,64}$/i.test(sourceRevision) ||
    typeof runId !== 'string' || !/^\d+$/.test(runId) ||
    typeof runAttempt !== 'string' || !/^\d+$/.test(runAttempt)
  ) {
    throw packageSmokeError('receipt provenance is invalid');
  }
  return {
    repository,
    workflowRef,
    sourceRevision: sourceRevision.toLowerCase(),
    run: { id: runId, attempt: runAttempt },
  };
}

function sha256InventoryFile(absolutePath, dependencies = {}) {
  const open = dependencies.openSync ?? openSync;
  const read = dependencies.readSync ?? readSync;
  const close = dependencies.closeSync ?? closeSync;
  const stat = dependencies.statSync ?? statSync;
  let descriptor;
  try {
    const fileStat = stat(absolutePath);
    if (!fileStat.isFile()) throw packageSmokeError(`inventory artifact is not a file: ${absolutePath}`);
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    descriptor = open(absolutePath, 'r');
    let position = 0;
    while (true) {
      const bytesRead = read(descriptor, buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return { sha256: hash.digest('hex'), sizeBytes: fileStat.size };
  } finally {
    if (descriptor !== undefined) close(descriptor);
  }
}

function runtimeHostInventoryPath(layout, artifactPath) {
  return join('resources', relative(layout.resourcesPath, artifactPath)).replaceAll('\\', '/');
}

function inventoryEntry(role, displayPath, absolutePath, dependencies) {
  return {
    role,
    path: displayPath,
    ...sha256InventoryFile(absolutePath, dependencies),
  };
}

function createRuntimeHostPackageInventoryBinding(plan, dependencies) {
  const inventory = [
    inventoryEntry('package', basename(plan.packageArtifactPath), plan.packageArtifactPath, dependencies),
    inventoryEntry('unpacked-runtime-host', runtimeHostInventoryPath(plan, plan.runtimeHostPath), plan.runtimeHostPath, dependencies),
    inventoryEntry('installed-runtime-host', runtimeHostInventoryPath(plan.installed, plan.installed.runtimeHostPath), plan.installed.runtimeHostPath, dependencies),
    inventoryEntry('unpacked-runtime-host-mcp', runtimeHostInventoryPath(plan, plan.runtimeHostMcpPath), plan.runtimeHostMcpPath, dependencies),
    inventoryEntry('installed-runtime-host-mcp', runtimeHostInventoryPath(plan.installed, plan.installed.runtimeHostMcpPath), plan.installed.runtimeHostMcpPath, dependencies),
    inventoryEntry('unpacked-bun', runtimeHostInventoryPath(plan, plan.bunPath), plan.bunPath, dependencies),
    inventoryEntry('installed-bun', runtimeHostInventoryPath(plan.installed, plan.installed.bunPath), plan.installed.bunPath, dependencies),
  ];
  if (plan.platform !== 'win32') {
    inventory.push(
      inventoryEntry(
        'unpacked-runtime-host-guardian',
        join('resources', 'bin', basename(plan.runtimeHostDirectory), basename(plan.guardianPath)).replaceAll('\\', '/'),
        plan.guardianPath,
        dependencies,
      ),
      inventoryEntry(
        'installed-runtime-host-guardian',
        join('resources', 'bin', basename(plan.installed.runtimeHostDirectory), basename(plan.installed.guardianPath)).replaceAll('\\', '/'),
        plan.installed.guardianPath,
        dependencies,
      ),
    );
  }
  return inventory;
}

function requireExactRecord(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw packageSmokeError(`${label} is invalid`);
  }
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...keys].sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw packageSmokeError(`${label} has an unexpected shape`);
  }
  return value;
}

function requireReceiptInventory(value) {
  if (!Array.isArray(value)) {
    throw packageSmokeError('receipt inventory is invalid');
  }
  return value.map((entry) => {
    const inventoryEntry = requireExactRecord(entry, ['role', 'path', 'sha256', 'sizeBytes'], 'receipt inventory entry');
    if (
      typeof inventoryEntry.role !== 'string' || inventoryEntry.role === '' ||
      typeof inventoryEntry.path !== 'string' || inventoryEntry.path === '' ||
      typeof inventoryEntry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(inventoryEntry.sha256) ||
      !Number.isSafeInteger(inventoryEntry.sizeBytes) || inventoryEntry.sizeBytes < 0
    ) {
      throw packageSmokeError('receipt inventory entry is invalid');
    }
    return inventoryEntry;
  });
}

function validateRuntimeHostPackageExecutionReceiptShape(receipt) {
  const cell = requireExactRecord(receipt?.cell, ['platform', 'arch', 'target'], 'receipt cell');
  if (!PACKAGE_SMOKE_CELLS.some((declaredCell) => (
    declaredCell.platform === cell.platform &&
    declaredCell.arch === cell.arch &&
    declaredCell.target === cell.target
  ))) {
    throw packageSmokeError('receipt cell is not declared by electron-builder');
  }
  const requiresWindowsNsisInstallation = cell.platform === 'win32' && cell.target === 'nsis';
  requireExactRecord(receipt, [
    'schemaVersion',
    'evidenceType',
    'cell',
    'provenance',
    'inventory',
    'execution',
    ...(requiresWindowsNsisInstallation ? ['installation'] : []),
  ], 'receipt');
  if (receipt.schemaVersion !== EVIDENCE_MANIFEST_VERSION || receipt.evidenceType !== 'runtime-host-package-execution') {
    throw packageSmokeError('receipt schema is unsupported');
  }
  const provenance = requireExactRecord(receipt.provenance, ['repository', 'workflowRef', 'sourceRevision', 'run'], 'receipt provenance');
  const run = requireExactRecord(provenance.run, ['id', 'attempt'], 'receipt provenance run');
  requireReceiptProvenance({
    repository: provenance.repository,
    workflowRef: provenance.workflowRef,
    sourceRevision: provenance.sourceRevision,
    runId: run.id,
    runAttempt: run.attempt,
  });
  const execution = requireExactRecord(receipt.execution, ['receiptVersion', 'kind', 'oracle', 'status'], 'receipt execution');
  if (
    execution.receiptVersion !== EVIDENCE_RECEIPT_VERSION ||
    execution.kind !== 'installed-native-run' ||
    execution.oracle !== 'bootstrap-rejection' ||
    execution.status !== 'passed'
  ) {
    throw packageSmokeError('receipt does not record a passed installed native execution');
  }
  const inventory = requireReceiptInventory(receipt.inventory);
  const installation = requiresWindowsNsisInstallation
    ? requireWindowsNsisInstallation(receipt.installation)
    : undefined;
  return { cell, inventory, installation };
}

function equalInventory(actual, expected) {
  return actual.length === expected.length && actual.every((entry, index) => (
    entry.role === expected[index].role &&
    entry.path === expected[index].path &&
    entry.sha256 === expected[index].sha256 &&
    entry.sizeBytes === expected[index].sizeBytes
  ));
}

/**
 * Produces the attestation subject that CI submits to GitHub's signed
 * provenance service. It refuses inventory-only, cross-build, or
 * unpacked-only metadata.
 */
export function createRuntimeHostPackageExecutionReceipt(plan, smoke, provenance, dependencies = {}) {
  const requiresWindowsNsisInstallation = plan.platform === 'win32' && plan.target === 'nsis';
  if (!requiresWindowsNsisInstallation && plan.installation !== undefined) {
    throw packageSmokeError('NSIS installation evidence is only valid for Windows NSIS receipts');
  }
  if (
    plan.execution !== 'native-run' ||
    plan.packageExecution !== 'installed-native-run' ||
    smoke?.execution !== 'native-run' ||
    smoke?.executionDetail !== 'bootstrap-rejection-passed' ||
    smoke?.packageExecution !== 'installed-native-run' ||
    smoke?.packageExecutionDetail !== 'bootstrap-rejection-passed' ||
    !plan.packageArtifactPath ||
    !plan.installed
  ) {
    throw packageSmokeError('execution receipt requires an installed native package run that passed the bootstrap-rejection oracle');
  }

  const receipt = {
    schemaVersion: EVIDENCE_MANIFEST_VERSION,
    evidenceType: 'runtime-host-package-execution',
    cell: { platform: plan.platform, arch: plan.arch, target: plan.target },
    provenance: requireReceiptProvenance(provenance),
    inventory: createRuntimeHostPackageInventoryBinding(plan, dependencies),
    execution: {
      receiptVersion: EVIDENCE_RECEIPT_VERSION,
      kind: 'installed-native-run',
      oracle: 'bootstrap-rejection',
      status: 'passed',
    },
    ...(plan.platform === 'win32' && plan.target === 'nsis' ? {
      installation: requireWindowsNsisInstallation(plan.installation),
    } : {}),
  };
  validateRuntimeHostPackageExecutionReceiptShape(receipt);
  return receipt;
}

/**
 * Revalidates a package receipt against the exact local package, unpacked,
 * and installed artifacts that it claims to bind. Signature verification is
 * deliberately external: CI signs the validated receipt with GitHub
 * provenance after this function succeeds.
 */
export function verifyRuntimeHostPackageExecutionReceipt(plan, receipt, dependencies = {}) {
  const { cell, inventory } = validateRuntimeHostPackageExecutionReceiptShape(receipt);
  const requiresWindowsNsisInstallation = plan.platform === 'win32' && plan.target === 'nsis';
  if (cell.platform !== plan.platform || cell.arch !== plan.arch || cell.target !== plan.target) {
    throw packageSmokeError('receipt cell does not bind the requested package cell');
  }
  if (requiresWindowsNsisInstallation !== (receipt.installation !== undefined)) {
    throw packageSmokeError('receipt installation does not match the requested package cell');
  }
  if (!equalInventory(inventory, createRuntimeHostPackageInventoryBinding(plan, dependencies))) {
    throw packageSmokeError('receipt inventory does not bind the current package artifacts');
  }
  return receipt;
}

export function writeRuntimeHostPackageExecutionReceipt(receiptPath, receipt, dependencies = {}) {
  if (typeof receiptPath !== 'string' || receiptPath.trim() === '') {
    throw packageSmokeError('receipt path is required');
  }
  validateRuntimeHostPackageExecutionReceiptShape(receipt);
  const destination = resolve(receiptPath);
  const makeDirectory = dependencies.mkdirSync ?? mkdirSync;
  const write = dependencies.writeFileSync ?? writeFileSync;
  makeDirectory(dirname(destination), { recursive: true });
  write(destination, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  return destination;
}

export function createRuntimeHostLocalPackageExecutionReceipt(plan, smoke, dependencies = {}) {
  if (
    plan.execution !== 'native-run' ||
    plan.packageExecution !== 'installed-native-run' ||
    smoke?.executionDetail !== 'bootstrap-rejection-passed' ||
    smoke?.packageExecutionDetail !== 'bootstrap-rejection-passed' ||
    !plan.localSourceRevision ||
    !plan.packageArtifactPath ||
    !plan.installed
  ) {
    throw packageSmokeError('local receipt requires an installed native package run that passed the bootstrap-rejection oracle');
  }
  const receipt = {
    schemaVersion: EVIDENCE_MANIFEST_VERSION,
    evidenceType: 'runtime-host-local-package-execution',
    cell: { platform: plan.platform, arch: plan.arch, target: plan.target },
    sourceRevision: plan.localSourceRevision,
    ...(plan.bunCacheEvidence ? { bunCacheEvidence: requireLocalBunCacheEvidence(plan.bunCacheEvidence) } : {}),
    ...(plan.uvCacheEvidence ? { uvCacheEvidence: requireLocalUvCacheEvidence(plan.uvCacheEvidence) } : {}),
    inventory: createRuntimeHostPackageInventoryBinding(plan, dependencies),
    execution: {
      receiptVersion: EVIDENCE_RECEIPT_VERSION,
      kind: 'installed-native-run',
      oracle: 'bootstrap-rejection',
      status: 'passed',
    },
    ...(plan.platform === 'win32' && plan.target === 'nsis' ? {
      installation: requireWindowsNsisInstallation(plan.installation),
    } : {}),
  };
  validateRuntimeHostLocalPackageExecutionReceiptShape(receipt);
  return receipt;
}

function requireLocalBunCacheEvidence(value) {
  const evidence = requireExactRecord(value, [
    'source', 'target', 'functionalMatch', 'independentProvenance', 'supplyChainAttestation',
  ], 'local Bun cache evidence');
  if (
    evidence.source !== 'local-cache' ||
    evidence.target !== 'win32-x64' ||
    evidence.functionalMatch !== 'exact-bun-1.4.2-win32-x64-pe' ||
    evidence.independentProvenance !== 'unverified' ||
    evidence.supplyChainAttestation !== 'not-present'
  ) {
    throw packageSmokeError('local Bun cache evidence is invalid');
  }
  return evidence;
}

function requireLocalUvCacheEvidence(value) {
  const evidence = requireExactRecord(value, [
    'source', 'target', 'functionalMatch', 'independentProvenance', 'supplyChainAttestation',
  ], 'local uv cache evidence');
  if (
    evidence.source !== 'local-cache' ||
    evidence.target !== 'win32-x64' ||
    evidence.functionalMatch !== 'exact-uv-0.10.0-win32-x64-pe' ||
    evidence.independentProvenance !== 'unverified' ||
    evidence.supplyChainAttestation !== 'not-present'
  ) {
    throw packageSmokeError('local uv cache evidence is invalid');
  }
  return evidence;
}

function validateRuntimeHostLocalPackageExecutionReceiptShape(receipt) {
  const cell = requireExactRecord(receipt?.cell, ['platform', 'arch', 'target'], 'local receipt cell');
  if (!PACKAGE_SMOKE_CELLS.some((declaredCell) => (
    declaredCell.platform === cell.platform && declaredCell.arch === cell.arch && declaredCell.target === cell.target
  ))) {
    throw packageSmokeError('local receipt cell is not declared by electron-builder');
  }
  const requiresWindowsNsisInstallation = cell.platform === 'win32' && cell.target === 'nsis';
  requireExactRecord(receipt, [
    'schemaVersion', 'evidenceType', 'cell', 'sourceRevision', 'inventory', 'execution',
    ...(receipt?.bunCacheEvidence ? ['bunCacheEvidence'] : []),
    ...(receipt?.uvCacheEvidence ? ['uvCacheEvidence'] : []),
    ...(requiresWindowsNsisInstallation ? ['installation'] : []),
  ], 'local receipt');
  if (
    receipt.schemaVersion !== EVIDENCE_MANIFEST_VERSION ||
    receipt.evidenceType !== 'runtime-host-local-package-execution' ||
    typeof receipt.sourceRevision !== 'string' ||
    !/^[a-f0-9]{40,64}$/i.test(receipt.sourceRevision)
  ) {
    throw packageSmokeError('local receipt is invalid');
  }
  if (receipt.bunCacheEvidence) requireLocalBunCacheEvidence(receipt.bunCacheEvidence);
  if (receipt.uvCacheEvidence) requireLocalUvCacheEvidence(receipt.uvCacheEvidence);
  const execution = requireExactRecord(receipt.execution, ['receiptVersion', 'kind', 'oracle', 'status'], 'local receipt execution');
  if (
    execution.receiptVersion !== EVIDENCE_RECEIPT_VERSION ||
    execution.kind !== 'installed-native-run' ||
    execution.oracle !== 'bootstrap-rejection' ||
    execution.status !== 'passed'
  ) {
    throw packageSmokeError('local receipt does not record a passed installed native execution');
  }
  const inventory = requireReceiptInventory(receipt.inventory);
  const installation = requiresWindowsNsisInstallation ? requireWindowsNsisInstallation(receipt.installation) : undefined;
  return { cell, inventory, installation };
}

export function verifyRuntimeHostLocalPackageExecutionReceipt(plan, receipt, dependencies = {}) {
  const { cell, inventory } = validateRuntimeHostLocalPackageExecutionReceiptShape(receipt);
  if (cell.platform !== plan.platform || cell.arch !== plan.arch || cell.target !== plan.target) {
    throw packageSmokeError('local receipt cell does not bind the requested package cell');
  }
  if (receipt.sourceRevision !== plan.localSourceRevision) {
    throw packageSmokeError('local receipt does not bind the requested source revision');
  }
  if (JSON.stringify(receipt.bunCacheEvidence) !== JSON.stringify(plan.bunCacheEvidence)) {
    throw packageSmokeError('local receipt does not bind the requested Bun cache evidence');
  }
  if (JSON.stringify(receipt.uvCacheEvidence) !== JSON.stringify(plan.uvCacheEvidence)) {
    throw packageSmokeError('local receipt does not bind the requested uv cache evidence');
  }
  if (!equalInventory(inventory, createRuntimeHostPackageInventoryBinding(plan, dependencies))) {
    throw packageSmokeError('local receipt inventory does not bind the current package artifacts');
  }
  return receipt;
}

export function writeRuntimeHostLocalPackageExecutionReceipt(receiptPath, receipt, dependencies = {}) {
  if (typeof receiptPath !== 'string' || receiptPath.trim() === '') {
    throw packageSmokeError('local receipt path is required');
  }
  validateRuntimeHostLocalPackageExecutionReceiptShape(receipt);
  const destination = resolve(receiptPath);
  const makeDirectory = dependencies.mkdirSync ?? mkdirSync;
  const write = dependencies.writeFileSync ?? writeFileSync;
  makeDirectory(dirname(destination), { recursive: true });
  write(destination, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  return destination;
}

function isBootstrapRejection(stderr) {
  return stderr.includes('runtime-host bootstrap input could not be read')
    || stderr.includes('runtime-host bootstrap configuration is invalid');
}

function defaultIsFile(absolutePath) {
  try {
    return lstatSync(absolutePath).isFile();
  } catch {
    return false;
  }
}

function defaultIsDirectory(absolutePath) {
  try {
    return lstatSync(absolutePath).isDirectory();
  } catch {
    return false;
  }
}

function defaultReadDirectory(absolutePath) {
  try {
    return readdirSync(absolutePath);
  } catch {
    return [];
  }
}

function findLegacyEntry(root, readDirectory, isDirectory) {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const name of readDirectory(directory)) {
      const entry = join(directory, name);
      if (LEGACY_ENTRY_NAMES.has(name)) return entry;
      if (isDirectory(entry)) pending.push(entry);
    }
  }
  return undefined;
}

function findLegacyAsarEntry(asarPath, readAsarHeader) {
  const header = readAsarHeader(asarPath);
  if (!header) return undefined;
  return findLegacyAsarFile(header.files, []);
}

function findLegacyAsarFile(files, ancestors) {
  if (!files || typeof files !== 'object') return undefined;
  for (const [name, entry] of Object.entries(files)) {
    const path = [...ancestors, name];
    if (LEGACY_ENTRY_NAMES.has(name) && entry && typeof entry === 'object' && !('files' in entry)) {
      return path.join('/');
    }
    const nested = findLegacyAsarFile(entry?.files, path);
    if (nested) return nested;
  }
  return undefined;
}

function readAsarHeader(asarPath) {
  try {
    const file = readFileSync(asarPath);
    if (file.length < 16) throw new Error('header too short');
    const headerLength = file.readUInt32LE(12);
    const headerStart = 16;
    const headerEnd = headerStart + headerLength;
    if (headerEnd > file.length) throw new Error('header exceeds file size');
    return JSON.parse(file.subarray(headerStart, headerEnd).toString('utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw packageSmokeError(`could not inspect app.asar inventory: ${asarPath}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const plan = createRuntimeHostPackageSmokePlan(parseRuntimeHostPackageSmokeArgs(process.argv.slice(2)));
    console.log(runRuntimeHostPackageSmoke(plan).report);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
