import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PACKAGE_SMOKE_CELLS,
  createRuntimeHostLocalPackageExecutionReceipt,
  createRuntimeHostPackageExecutionReceipt,
  createRuntimeHostPackageSmokePlan,
  inspectRuntimeHostPackageInventory,
  parseRuntimeHostPackageSmokeArgs,
  runRuntimeHostPackageSmoke,
  verifyRuntimeHostLocalPackageExecutionReceipt,
  verifyRuntimeHostPackageExecutionReceipt,
  writeRuntimeHostLocalPackageExecutionReceipt,
  writeRuntimeHostPackageExecutionReceipt,
} from '../../scripts/package-smoke-runtime-host.mjs';

const tempRoots: string[] = [];

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'matchaclaw-package-smoke-'));
  tempRoots.push(root);
  return root;
}

function createUnpackedArtifact(root: string, platform: 'darwin' | 'linux' | 'win32', arch: 'x64' | 'arm64'): string {
  const unpacked = platform === 'darwin'
    ? join(root, 'MatchaClaw.app')
    : join(root, `${platform}-unpacked`);
  const resources = platform === 'darwin'
    ? join(unpacked, 'Contents', 'Resources')
    : join(unpacked, 'resources');
  const runtimeHostDir = join(resources, 'bin', `${platform}-${arch}`);
  mkdirSync(runtimeHostDir, { recursive: true });
  const runtimeHost = join(runtimeHostDir, platform === 'win32' ? 'runtime-host.exe' : 'runtime-host');
  const runtimeHostMcp = join(runtimeHostDir, platform === 'win32' ? 'runtime-host-mcp.exe' : 'runtime-host-mcp');
  const bun = join(resources, 'bin', platform === 'win32' ? 'bun.exe' : 'bun');
  writeFileSync(runtimeHost, 'fixture-runtime-host');
  writeFileSync(runtimeHostMcp, 'fixture-runtime-host-mcp');
  writeFileSync(bun, 'fixture-bun');
  if (platform !== 'win32') {
    writeFileSync(join(runtimeHostDir, 'runtime-host-guardian'), 'fixture-guardian');
  }
  return unpacked;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('runtime-host package smoke runner', () => {
  it('derives the complete electron-builder package-cell matrix', () => {
    expect(PACKAGE_SMOKE_CELLS).toEqual([
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
  });

  it('parses one prebuilt package cell without starting a build or package command', () => {
    expect(parseRuntimeHostPackageSmokeArgs([
      '--platform', 'win32',
      '--arch', 'x64',
      '--target', 'nsis',
      '--unpacked', 'release/win-unpacked',
      '--package', 'release/MatchaClaw.exe',
      '--run',
    ])).toEqual({
      platform: 'win32',
      arch: 'x64',
      target: 'nsis',
      unpackedArtifactPath: 'release/win-unpacked',
      packageArtifactPath: 'release/MatchaClaw.exe',
      runNative: true,
    });
    expect(() => parseRuntimeHostPackageSmokeArgs([
      '--platform', 'win32', '--arch', 'x64', '--target', 'nsis',
    ])).toThrow(/required options/);
    expect(() => parseRuntimeHostPackageSmokeArgs([
      '--platform', 'win32', '--platform', 'win32', '--arch', 'x64', '--target', 'nsis', '--unpacked', 'release/win-unpacked',
    ])).toThrow(/duplicate option/);
    expect(() => parseRuntimeHostPackageSmokeArgs([
      '--platform', 'win32', '--arch', 'x64', '--target', 'nsis', '--unpacked', 'release/win-unpacked',
      '--receipt', 'release/evidence.json',
    ])).toThrow(/requires complete receipt provenance/);
  });

  it('selects only declared cells and distinguishes native, cross-build, and uncovered execution', () => {
    const root = createTempRoot();
    const unpacked = createUnpackedArtifact(root, 'win32', 'x64');

    expect(() => createRuntimeHostPackageSmokePlan({
      platform: 'win32', arch: 'x64', target: 'dmg', unpackedArtifactPath: unpacked,
    })).toThrow(/not declared by electron-builder/);
    expect(createRuntimeHostPackageSmokePlan({
      platform: 'win32', arch: 'x64', target: 'nsis', unpackedArtifactPath: unpacked,
      hostPlatform: 'win32', hostArch: 'x64', runNative: true,
    }).execution).toBe('native-run');
    expect(createRuntimeHostPackageSmokePlan({
      platform: 'win32', arch: 'arm64', target: 'nsis', unpackedArtifactPath: unpacked,
      hostPlatform: 'win32', hostArch: 'x64', runNative: true,
    }).execution).toBe('cross-build');
    expect(createRuntimeHostPackageSmokePlan({
      platform: 'win32', arch: 'x64', target: 'nsis', unpackedArtifactPath: unpacked,
    }).execution).toBe('uncovered');
  });

  it('requires a package artifact and a matching native host before it treats an installed application root as package execution', () => {
    const root = createTempRoot();
    const unpacked = createUnpackedArtifact(root, 'win32', 'x64');
    const installed = createUnpackedArtifact(join(root, 'installed'), 'win32', 'x64');
    const packageArtifact = join(root, 'MatchaClaw.exe');
    writeFileSync(packageArtifact, 'installer');

    expect(() => parseRuntimeHostPackageSmokeArgs([
      '--platform', 'win32', '--arch', 'x64', '--target', 'nsis',
      '--unpacked', unpacked, '--installed', installed,
    ])).toThrow(/requires --package/);

    expect(createRuntimeHostPackageSmokePlan({
      platform: 'win32', arch: 'x64', target: 'nsis',
      unpackedArtifactPath: unpacked,
      packageArtifactPath: packageArtifact,
      installedArtifactPath: installed,
      hostPlatform: 'win32', hostArch: 'x64', runNative: true,
    })).toMatchObject({
      execution: 'native-run',
      packageExecution: 'installed-native-run',
    });

    expect(createRuntimeHostPackageSmokePlan({
      platform: 'win32', arch: 'arm64', target: 'nsis',
      unpackedArtifactPath: unpacked,
      packageArtifactPath: packageArtifact,
      installedArtifactPath: installed,
      hostPlatform: 'win32', hostArch: 'x64', runNative: true,
    }).packageExecution).toBe('cross-build');
  });

  it('checks the target-qualified runtime-host and guardian inventory without calling it package execution', () => {
    const root = createTempRoot();
    const unpacked = createUnpackedArtifact(root, 'linux', 'x64');
    const plan = createRuntimeHostPackageSmokePlan({
      platform: 'linux', arch: 'x64', target: 'AppImage', unpackedArtifactPath: unpacked,
    });

    expect(inspectRuntimeHostPackageInventory(plan)).toMatchObject({
      bun: 'present',
      guardian: 'present',
      packageArtifact: 'not-provided',
      runtimeHost: 'present',
      runtimeHostMcp: 'present',
    });

    rmSync(join(unpacked, 'resources', 'bin', 'linux-x64'), { recursive: true });
    expect(() => inspectRuntimeHostPackageInventory(plan)).toThrow(/runtime-host directory is not a directory/);
  });

  it('rejects a missing Rust MCP artifact from the target-qualified package layout', () => {
    const root = createTempRoot();
    const unpacked = createUnpackedArtifact(root, 'win32', 'x64');
    const plan = createRuntimeHostPackageSmokePlan({
      platform: 'win32', arch: 'x64', target: 'nsis', unpackedArtifactPath: unpacked,
    });

    rmSync(join(unpacked, 'resources', 'bin', 'win32-x64', 'runtime-host-mcp.exe'));

    expect(() => inspectRuntimeHostPackageInventory(plan)).toThrow(/runtime-host-mcp artifact/);
  });

  it.each([
    ['darwin', 'arm64', 'zip', 'bun'],
    ['linux', 'x64', 'AppImage', 'bun'],
    ['win32', 'x64', 'nsis', 'bun.exe'],
  ] as const)('rejects a missing packaged Bun artifact for %s %s %s', (platform, arch, target, bunName) => {
    const root = createTempRoot();
    const unpacked = createUnpackedArtifact(root, platform, arch);
    const plan = createRuntimeHostPackageSmokePlan({
      platform, arch, target, unpackedArtifactPath: unpacked,
    });
    const resources = platform === 'darwin'
      ? join(unpacked, 'Contents', 'Resources')
      : join(unpacked, 'resources');

    rmSync(join(resources, 'bin', bunName));

    expect(() => inspectRuntimeHostPackageInventory(plan)).toThrow(/Bun artifact/);
  });

  it('rejects a missing Unix guardian, a Windows guardian, and legacy package entries', () => {
    const root = createTempRoot();
    const linuxUnpacked = createUnpackedArtifact(root, 'linux', 'x64');
    rmSync(join(linuxUnpacked, 'resources', 'bin', 'linux-x64', 'runtime-host-guardian'));
    const linuxPlan = createRuntimeHostPackageSmokePlan({
      platform: 'linux', arch: 'x64', target: 'deb', unpackedArtifactPath: linuxUnpacked,
    });
    expect(() => inspectRuntimeHostPackageInventory(linuxPlan)).toThrow(/runtime-host-guardian/);

    const windowsUnpacked = createUnpackedArtifact(root, 'win32', 'x64');
    const windowsBinDir = join(windowsUnpacked, 'resources', 'bin', 'win32-x64');
    writeFileSync(join(windowsBinDir, 'runtime-host-guardian'), 'stale guardian');
    const windowsPlan = createRuntimeHostPackageSmokePlan({
      platform: 'win32', arch: 'x64', target: 'nsis', unpackedArtifactPath: windowsUnpacked,
    });
    expect(() => inspectRuntimeHostPackageInventory(windowsPlan)).toThrow(/unexpected runtime-host-guardian/);

    rmSync(join(windowsBinDir, 'runtime-host-guardian'));
    const legacyEntry = join(windowsUnpacked, 'resources', 'runtime-host', 'build', 'main-cli.js');
    mkdirSync(join(legacyEntry, '..'), { recursive: true });
    writeFileSync(legacyEntry, 'legacy entry');
    expect(() => inspectRuntimeHostPackageInventory(windowsPlan)).toThrow(/main-cli\.js/);

    rmSync(legacyEntry);
    const legacyHostProcess = join(windowsUnpacked, 'resources', 'runtime-host', 'host-process.cjs');
    writeFileSync(legacyHostProcess, 'legacy process entry');
    expect(() => inspectRuntimeHostPackageInventory(windowsPlan)).toThrow(/host-process\.cjs/);

    rmSync(legacyHostProcess);
    expect(() => inspectRuntimeHostPackageInventory(windowsPlan, {
      readAsarHeader() {
        return { files: { 'runtime-host': { files: { build: { files: { 'main-cli.js': { size: 1 } } } } } } };
      },
    })).toThrow(/app\.asar\/runtime-host\/build\/main-cli\.js/);
    expect(() => inspectRuntimeHostPackageInventory(windowsPlan, {
      readAsarHeader() {
        return { files: { 'runtime-host': { files: { 'host-process.cjs': { size: 1 } } } } };
      },
    })).toThrow(/app\.asar\/runtime-host\/host-process\.cjs/);
  });

  it('runs only a host-native runtime-host binary and reports the bounded bootstrap-rejection oracle', () => {
    const root = createTempRoot();
    const unpacked = createUnpackedArtifact(root, 'win32', 'x64');
    const plan = createRuntimeHostPackageSmokePlan({
      platform: 'win32', arch: 'x64', target: 'nsis', unpackedArtifactPath: unpacked,
      hostPlatform: 'win32', hostArch: 'x64', runNative: true,
    });

    const result = runRuntimeHostPackageSmoke(plan, {
      spawnSync(command, args, options) {
        expect(command).toBe(plan.runtimeHostPath);
        expect(args).toEqual([]);
        expect(options.input).toBe('');
        expect(options.timeout).toBe(5_000);
        return { status: 1, stderr: 'runtime-host: runtime-host bootstrap input could not be read\n' };
      },
    });

    expect(result).toMatchObject({
      execution: 'native-run',
      executionDetail: 'bootstrap-rejection-passed',
      inventory: 'passed-not-execution',
    });
    expect(result.report).toContain('inventory=passed-not-execution');
    expect(result.report).toContain('runtime-host-execution=native-run (bootstrap-rejection-passed)');
    expect(result.report).toContain('package-execution=uncovered-no-package-artifact');
  });

  it("accepts the current binary's redacted invalid-bootstrap rejection", () => {
    const root = createTempRoot();
    const unpacked = createUnpackedArtifact(root, 'win32', 'x64');
    const plan = createRuntimeHostPackageSmokePlan({
      platform: 'win32', arch: 'x64', target: 'nsis', unpackedArtifactPath: unpacked,
      hostPlatform: 'win32', hostArch: 'x64', runNative: true,
    });

    expect(runRuntimeHostPackageSmoke(plan, {
      spawnSync() {
        return { status: 1, stderr: 'runtime-host: runtime-host bootstrap configuration is invalid\n' };
      },
    })).toMatchObject({ execution: 'native-run', executionDetail: 'bootstrap-rejection-passed' });
  });

  it.each(['x64', 'arm64'] as const)('executes a Windows %s installed application root separately after a native package installation', (arch) => {
    const root = createTempRoot();
    const unpacked = createUnpackedArtifact(root, 'win32', arch);
    const installed = createUnpackedArtifact(join(root, 'installed'), 'win32', arch);
    const packageArtifact = join(root, `MatchaClaw-win-${arch}.exe`);
    writeFileSync(packageArtifact, 'installer');
    const plan = createRuntimeHostPackageSmokePlan({
      platform: 'win32', arch, target: 'nsis',
      unpackedArtifactPath: unpacked,
      packageArtifactPath: packageArtifact,
      installedArtifactPath: installed,
      hostPlatform: 'win32', hostArch: arch, runNative: true,
    });
    const executed: string[] = [];

    const result = runRuntimeHostPackageSmoke(plan, {
      spawnSync(command) {
        executed.push(command);
        return { status: 1, stderr: 'runtime-host: runtime-host bootstrap input could not be read\n' };
      },
    });

    expect(executed).toEqual([plan.runtimeHostPath, plan.installed.runtimeHostPath]);
    expect(result).toMatchObject({
      packageExecution: 'installed-native-run',
      packageExecutionDetail: 'bootstrap-rejection-passed',
    });
    expect(result.report).toContain('package-execution=installed-native-run (bootstrap-rejection-passed)');
  });

  it.each(['dmg', 'zip'] as const)('executes a %s-extracted macOS arm64 application bundle separately from its unpacked build root', (target) => {
    const root = createTempRoot();
    const unpacked = createUnpackedArtifact(root, 'darwin', 'arm64');
    const mounted = createUnpackedArtifact(join(root, `mounted-${target}`), 'darwin', 'arm64');
    const packageArtifact = join(root, `MatchaClaw-mac-arm64.${target}`);
    writeFileSync(packageArtifact, `${target} bytes`);
    const plan = createRuntimeHostPackageSmokePlan({
      platform: 'darwin', arch: 'arm64', target,
      unpackedArtifactPath: unpacked,
      packageArtifactPath: packageArtifact,
      installedArtifactPath: mounted,
      hostPlatform: 'darwin', hostArch: 'arm64', runNative: true,
    });
    const executed: string[] = [];

    const result = runRuntimeHostPackageSmoke(plan, {
      spawnSync(command) {
        executed.push(command);
        return { status: 1, stderr: 'runtime-host: runtime-host bootstrap input could not be read\n' };
      },
    });

    expect(plan.installed?.runtimeHostPath).toBe(join(mounted, 'Contents', 'Resources', 'bin', 'darwin-arm64', 'runtime-host'));
    expect(executed).toEqual([plan.runtimeHostPath, plan.installed?.runtimeHostPath]);
    expect(result).toMatchObject({
      packageExecution: 'installed-native-run',
      packageExecutionDetail: 'bootstrap-rejection-passed',
    });
  });

  it.each([
    ['linux', 'x64', 'AppImage'],
    ['linux', 'x64', 'deb'],
    ['linux', 'x64', 'rpm'],
    ['linux', 'arm64', 'AppImage'],
    ['linux', 'arm64', 'deb'],
  ] as const)('executes a %s %s %s extracted application root separately from its unpacked build root', (platform, arch, target) => {
    const root = createTempRoot();
    const unpacked = createUnpackedArtifact(root, platform, arch);
    const extracted = createUnpackedArtifact(join(root, `extracted-${arch}-${target}`), platform, arch);
    const packageArtifact = join(root, `MatchaClaw-${platform}-${arch}.${target}`);
    writeFileSync(packageArtifact, `${target} bytes`);
    const plan = createRuntimeHostPackageSmokePlan({
      platform, arch, target,
      unpackedArtifactPath: unpacked,
      packageArtifactPath: packageArtifact,
      installedArtifactPath: extracted,
      hostPlatform: platform, hostArch: arch, runNative: true,
    });
    const executed: string[] = [];

    const result = runRuntimeHostPackageSmoke(plan, {
      spawnSync(command) {
        executed.push(command);
        return { status: 1, stderr: 'runtime-host: runtime-host bootstrap input could not be read\n' };
      },
    });

    expect(plan.installed?.runtimeHostPath).toBe(join(extracted, 'resources', 'bin', `${platform}-${arch}`, 'runtime-host'));
    expect(executed).toEqual([plan.runtimeHostPath, plan.installed?.runtimeHostPath]);
    expect(result).toMatchObject({
      packageExecution: 'installed-native-run',
      packageExecutionDetail: 'bootstrap-rejection-passed',
    });
  });

  it.each(['dmg', 'zip'] as const)('executes a %s-mounted or extracted macOS x64 application bundle separately from its unpacked build root', (target) => {
    const root = createTempRoot();
    const unpacked = createUnpackedArtifact(root, 'darwin', 'x64');
    const installed = createUnpackedArtifact(join(root, `installed-x64-${target}`), 'darwin', 'x64');
    const packageArtifact = join(root, `MatchaClaw-mac-x64.${target}`);
    writeFileSync(packageArtifact, `${target} bytes`);
    const plan = createRuntimeHostPackageSmokePlan({
      platform: 'darwin', arch: 'x64', target,
      unpackedArtifactPath: unpacked,
      packageArtifactPath: packageArtifact,
      installedArtifactPath: installed,
      hostPlatform: 'darwin', hostArch: 'x64', runNative: true,
    });
    const executed: string[] = [];

    const result = runRuntimeHostPackageSmoke(plan, {
      spawnSync(command) {
        executed.push(command);
        return { status: 1, stderr: 'runtime-host: runtime-host bootstrap input could not be read\n' };
      },
    });

    expect(executed).toEqual([plan.runtimeHostPath, plan.installed?.runtimeHostPath]);
    expect(result).toMatchObject({
      packageExecution: 'installed-native-run',
      packageExecutionDetail: 'bootstrap-rejection-passed',
    });
  });

  it('requires NSIS installation evidence only for Windows NSIS receipts', () => {
    const receiptArgs = [
      '--platform', 'win32', '--arch', 'x64', '--target', 'nsis',
      '--unpacked', 'release/win-unpacked', '--package', 'release/MatchaClaw.exe', '--installed', 'release/installed',
      '--receipt', 'release/evidence.json', '--repository', 'hellowKeyzj/Matcha-claw',
      '--workflow-ref', '.github/workflows/release.yml', '--source-revision', 'a'.repeat(40),
      '--run-id', '123', '--run-attempt', '4', '--run',
    ];

    expect(() => parseRuntimeHostPackageSmokeArgs(receiptArgs)).toThrow(/Windows NSIS receipts require/);
    expect(() => parseRuntimeHostPackageSmokeArgs([
      ...receiptArgs, '--nsis-install-duration-ms', '-1', '--nsis-install-exit-code', '0',
    ])).toThrow(/nonnegative safe integer/);
    expect(() => parseRuntimeHostPackageSmokeArgs([
      ...receiptArgs, '--nsis-install-duration-ms', '1.5', '--nsis-install-exit-code', '0',
    ])).toThrow(/nonnegative safe integer/);
    expect(() => parseRuntimeHostPackageSmokeArgs([
      ...receiptArgs, '--nsis-install-duration-ms', '9007199254740992', '--nsis-install-exit-code', '0',
    ])).toThrow(/nonnegative safe integer/);
    expect(() => parseRuntimeHostPackageSmokeArgs([
      ...receiptArgs, '--nsis-install-duration-ms', '1', '--nsis-install-exit-code', '1',
    ])).toThrow(/must be 0/);
    expect(parseRuntimeHostPackageSmokeArgs([
      ...receiptArgs, '--nsis-install-duration-ms', '42', '--nsis-install-exit-code', '0',
    ]).installation).toEqual({
      scenario: 'fresh-silent-temporary-root',
      clock: 'monotonic',
      startBoundary: 'immediately-before-nsis-process-invocation',
      endBoundary: 'immediately-after-nsis-process-return',
      durationMs: 42,
      exitCode: 0,
    });
    expect(() => parseRuntimeHostPackageSmokeArgs([
      '--platform', 'linux', '--arch', 'x64', '--target', 'deb', '--unpacked', 'release/linux-unpacked',
      '--nsis-install-duration-ms', '42', '--nsis-install-exit-code', '0',
    ])).toThrow(/only valid for Windows NSIS receipts/);
    expect(() => createRuntimeHostPackageSmokePlan({
      platform: 'win32', arch: 'arm64', target: 'nsis',
      unpackedArtifactPath: 'release/win-arm64-unpacked', packageArtifactPath: 'release/MatchaClaw.exe',
      installedArtifactPath: 'release/installed', receiptPath: 'release/evidence.json',
      hostPlatform: 'win32', hostArch: 'x64', runNative: true,
    })).toThrow(/require a native Windows package run/);
    expect(() => createRuntimeHostPackageSmokePlan({
      platform: 'win32', arch: 'x64', target: 'nsis',
      unpackedArtifactPath: 'release/win-unpacked', packageArtifactPath: 'release/MatchaClaw.exe',
      installedArtifactPath: 'release/installed', receiptPath: 'release/evidence.json',
      hostPlatform: 'linux', hostArch: 'x64', runNative: true,
    })).toThrow(/require a native Windows package run/);
  });

  it('binds the exact package and installed runtime-host inventory to a native execution receipt', () => {
    const root = createTempRoot();
    const unpacked = createUnpackedArtifact(root, 'win32', 'x64');
    const installed = createUnpackedArtifact(join(root, 'installed'), 'win32', 'x64');
    const packageArtifact = join(root, 'MatchaClaw.exe');
    writeFileSync(packageArtifact, 'installer bytes');
    const plan = createRuntimeHostPackageSmokePlan({
      platform: 'win32', arch: 'x64', target: 'nsis',
      unpackedArtifactPath: unpacked,
      packageArtifactPath: packageArtifact,
      installedArtifactPath: installed,
      hostPlatform: 'win32', hostArch: 'x64', runNative: true,
      installation: {
        scenario: 'fresh-silent-temporary-root',
        clock: 'monotonic',
        startBoundary: 'immediately-before-nsis-process-invocation',
        endBoundary: 'immediately-after-nsis-process-return',
        durationMs: 42,
        exitCode: 0,
      },
    });
    const smoke = runRuntimeHostPackageSmoke(plan, {
      spawnSync() {
        return { status: 1, stderr: 'runtime-host: runtime-host bootstrap input could not be read\n' };
      },
    });
    const provenance = {
      repository: 'hellowKeyzj/Matcha-claw',
      workflowRef: '.github/workflows/release.yml',
      sourceRevision: 'a'.repeat(40),
      runId: '123',
      runAttempt: '4',
    };

    const receipt = createRuntimeHostPackageExecutionReceipt(plan, smoke, provenance);
    expect(receipt).toMatchObject({
      schemaVersion: 2,
      evidenceType: 'runtime-host-package-execution',
      cell: { platform: 'win32', arch: 'x64', target: 'nsis' },
      provenance: { sourceRevision: 'a'.repeat(40), run: { id: '123', attempt: '4' } },
      execution: { kind: 'installed-native-run', oracle: 'bootstrap-rejection', status: 'passed' },
      installation: {
        scenario: 'fresh-silent-temporary-root',
        clock: 'monotonic',
        startBoundary: 'immediately-before-nsis-process-invocation',
        endBoundary: 'immediately-after-nsis-process-return',
        durationMs: 42,
        exitCode: 0,
      },
    });
    expect(receipt.inventory.map((entry) => entry.role)).toEqual([
      'package',
      'unpacked-runtime-host',
      'installed-runtime-host',
      'unpacked-runtime-host-mcp',
      'installed-runtime-host-mcp',
      'unpacked-bun',
      'installed-bun',
    ]);
    expect(receipt.inventory.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256))).toBe(true);

    expect(verifyRuntimeHostPackageExecutionReceipt(plan, receipt)).toEqual(receipt);
    expect(() => verifyRuntimeHostPackageExecutionReceipt(plan, {
      ...receipt,
      installation: { ...receipt.installation, durationMs: -1 },
    })).toThrow(/receipt installation is invalid/);
    expect(() => verifyRuntimeHostPackageExecutionReceipt(plan, {
      ...receipt,
      installation: { ...receipt.installation, unexpected: true },
    })).toThrow(/receipt installation has an unexpected shape/);
    expect(() => verifyRuntimeHostPackageExecutionReceipt(plan, {
      ...receipt,
      unexpected: true,
    })).toThrow(/receipt has an unexpected shape/);
    expect(() => writeRuntimeHostPackageExecutionReceipt(join(root, 'evidence', 'forged-receipt.json'), {
      ...receipt,
      unexpected: true,
    })).toThrow(/receipt has an unexpected shape/);
    expect(() => writeRuntimeHostPackageExecutionReceipt(join(root, 'evidence', 'invalid-installation.json'), {
      ...receipt,
      installation: { ...receipt.installation, durationMs: -1 },
    })).toThrow(/receipt installation is invalid/);
    expect(() => writeRuntimeHostPackageExecutionReceipt(join(root, 'evidence', 'non-windows-installation.json'), {
      ...receipt,
      cell: { platform: 'linux', arch: 'x64', target: 'deb' },
    })).toThrow(/receipt has an unexpected shape/);
    const receiptPath = writeRuntimeHostPackageExecutionReceipt(join(root, 'evidence', 'receipt.json'), receipt);
    expect(JSON.parse(readFileSync(receiptPath, 'utf8'))).toEqual(receipt);

    writeFileSync(installed + '/resources/bin/win32-x64/runtime-host-mcp.exe', 'changed');
    expect(() => verifyRuntimeHostPackageExecutionReceipt(plan, receipt)).toThrow(/inventory does not bind/);
  });

  it('writes a local receipt only for the exact native package and source revision without CI provenance', () => {
    const root = createTempRoot();
    const unpacked = createUnpackedArtifact(root, 'win32', 'x64');
    const installed = createUnpackedArtifact(join(root, 'installed'), 'win32', 'x64');
    const packageArtifact = join(root, 'MatchaClaw.exe');
    writeFileSync(packageArtifact, 'installer bytes');
    const plan = createRuntimeHostPackageSmokePlan({
      platform: 'win32', arch: 'x64', target: 'nsis',
      unpackedArtifactPath: unpacked,
      packageArtifactPath: packageArtifact,
      installedArtifactPath: installed,
      localReceiptPath: join(root, 'evidence', 'local-receipt.json'),
      sourceRevision: 'b'.repeat(40),
      hostPlatform: 'win32', hostArch: 'x64', runNative: true,
      installation: {
        scenario: 'fresh-silent-temporary-root',
        clock: 'monotonic',
        startBoundary: 'immediately-before-nsis-process-invocation',
        endBoundary: 'immediately-after-nsis-process-return',
        durationMs: 19,
        exitCode: 0,
      },
    });
    const smoke = runRuntimeHostPackageSmoke(plan, {
      spawnSync() {
        return { status: 1, stderr: 'runtime-host: runtime-host bootstrap input could not be read\n' };
      },
    });
    const receipt = createRuntimeHostLocalPackageExecutionReceipt(plan, smoke);

    expect(receipt).toMatchObject({
      evidenceType: 'runtime-host-local-package-execution',
      sourceRevision: 'b'.repeat(40),
      execution: { kind: 'installed-native-run', oracle: 'bootstrap-rejection', status: 'passed' },
    });
    expect(receipt).not.toHaveProperty('provenance');
    expect(verifyRuntimeHostLocalPackageExecutionReceipt(plan, receipt)).toEqual(receipt);
    const receiptPath = writeRuntimeHostLocalPackageExecutionReceipt(plan.localReceiptPath!, receipt);
    expect(JSON.parse(readFileSync(receiptPath, 'utf8'))).toEqual(receipt);

    writeFileSync(installed + '/resources/bin/win32-x64/runtime-host.exe', 'changed');
    expect(() => verifyRuntimeHostLocalPackageExecutionReceipt(plan, receipt)).toThrow(/inventory does not bind/);
  });

  it('records a functional Bun cache match only as independently unverified local evidence', () => {
    const root = createTempRoot();
    const unpacked = createUnpackedArtifact(root, 'win32', 'x64');
    const installed = createUnpackedArtifact(join(root, 'installed'), 'win32', 'x64');
    const packageArtifact = join(root, 'MatchaClaw.exe');
    writeFileSync(packageArtifact, 'installer bytes');
    const plan = createRuntimeHostPackageSmokePlan({
      platform: 'win32', arch: 'x64', target: 'nsis',
      unpackedArtifactPath: unpacked,
      packageArtifactPath: packageArtifact,
      installedArtifactPath: installed,
      localReceiptPath: join(root, 'evidence', 'local-receipt.json'),
      sourceRevision: 'c'.repeat(40),
      bunCacheEvidence: {
        source: 'local-cache',
        target: 'win32-x64',
        functionalMatch: 'exact-bun-1.4.2-win32-x64-pe',
        independentProvenance: 'unverified',
        supplyChainAttestation: 'not-present',
      },
      hostPlatform: 'win32', hostArch: 'x64', runNative: true,
      installation: {
        scenario: 'fresh-silent-temporary-root',
        clock: 'monotonic',
        startBoundary: 'immediately-before-nsis-process-invocation',
        endBoundary: 'immediately-after-nsis-process-return',
        durationMs: 1,
        exitCode: 0,
      },
    });
    const smoke = runRuntimeHostPackageSmoke(plan, {
      spawnSync() {
        return { status: 1, stderr: 'runtime-host: runtime-host bootstrap input could not be read\n' };
      },
    });

    expect(createRuntimeHostLocalPackageExecutionReceipt(plan, smoke)).toMatchObject({
      bunCacheEvidence: {
        source: 'local-cache',
        independentProvenance: 'unverified',
        supplyChainAttestation: 'not-present',
      },
    });
  });

  it('parses local receipt source evidence without CI provenance', () => {
    expect(parseRuntimeHostPackageSmokeArgs([
      '--platform', 'win32', '--arch', 'x64', '--target', 'nsis',
      '--unpacked', 'release/win-unpacked', '--package', 'release/MatchaClaw.exe', '--installed', 'release/installed',
      '--local-receipt', 'release/local-evidence.json', '--source-revision', 'a'.repeat(40),
      '--nsis-install-duration-ms', '42', '--nsis-install-exit-code', '0', '--run',
    ])).toMatchObject({
      localReceiptPath: 'release/local-evidence.json',
      sourceRevision: 'a'.repeat(40),
    });
  });

  it('rejects local receipt CI provenance and non-native metadata', () => {
    expect(() => parseRuntimeHostPackageSmokeArgs([
      '--platform', 'win32', '--arch', 'x64', '--target', 'nsis',
      '--unpacked', 'release/win-unpacked', '--package', 'release/MatchaClaw.exe', '--installed', 'release/installed',
      '--local-receipt', 'release/local-evidence.json', '--source-revision', 'a'.repeat(40), '--repository', 'owner/repo', '--run',
    ])).toThrow(/source-revision only, without CI provenance/);
    expect(() => parseRuntimeHostPackageSmokeArgs([
      '--platform', 'win32', '--arch', 'x64', '--target', 'nsis',
      '--unpacked', 'release/win-unpacked', '--package', 'release/MatchaClaw.exe', '--installed', 'release/installed',
      '--local-receipt', 'release/local-evidence.json', '--source-revision', 'not-a-revision', '--run',
    ])).toThrow(/source revision is invalid/);
  });

  it('refuses to issue an execution receipt for inventory-only or cross-build metadata', () => {
    const root = createTempRoot();
    const unpacked = createUnpackedArtifact(root, 'win32', 'arm64');
    const plan = createRuntimeHostPackageSmokePlan({
      platform: 'win32', arch: 'arm64', target: 'nsis', unpackedArtifactPath: unpacked,
      hostPlatform: 'win32', hostArch: 'x64', runNative: true,
    });
    const smoke = runRuntimeHostPackageSmoke(plan, {
      spawnSync() {
        throw new Error('cross build must not execute');
      },
    });

    expect(() => createRuntimeHostPackageExecutionReceipt(plan, smoke, {
      repository: 'hellowKeyzj/Matcha-claw',
      workflowRef: '.github/workflows/release.yml',
      sourceRevision: 'a'.repeat(40),
      runId: '123',
      runAttempt: '4',
    })).toThrow(/installed native package run/);
  });

  it('refuses a forged installed-native-run smoke result when the plan was not native', () => {
    const root = createTempRoot();
    const unpacked = createUnpackedArtifact(root, 'win32', 'arm64');
    const installed = createUnpackedArtifact(join(root, 'installed'), 'win32', 'arm64');
    const packageArtifact = join(root, 'MatchaClaw-win-arm64.exe');
    writeFileSync(packageArtifact, 'installer');
    const plan = createRuntimeHostPackageSmokePlan({
      platform: 'win32', arch: 'arm64', target: 'nsis',
      unpackedArtifactPath: unpacked,
      packageArtifactPath: packageArtifact,
      installedArtifactPath: installed,
      hostPlatform: 'win32', hostArch: 'x64', runNative: true,
    });

    expect(() => createRuntimeHostPackageExecutionReceipt(plan, {
      execution: 'native-run',
      executionDetail: 'bootstrap-rejection-passed',
      packageExecution: 'installed-native-run',
      packageExecutionDetail: 'bootstrap-rejection-passed',
    }, {
      repository: 'hellowKeyzj/Matcha-claw',
      workflowRef: '.github/workflows/release.yml',
      sourceRevision: 'a'.repeat(40),
      runId: '123',
      runAttempt: '4',
    })).toThrow(/installed native package run/);
  });

  it('refuses an undeclared Linux ARM64 RPM cell rather than treating a fabricated package as covered', () => {
    const root = createTempRoot();
    const unpacked = createUnpackedArtifact(root, 'linux', 'arm64');

    expect(() => createRuntimeHostPackageSmokePlan({
      platform: 'linux', arch: 'arm64', target: 'rpm', unpackedArtifactPath: unpacked,
    })).toThrow(/not declared by electron-builder/);
  });

  it('does not invoke a cross-built binary and marks it separately from an uncovered cell', () => {
    const root = createTempRoot();
    const unpacked = createUnpackedArtifact(root, 'win32', 'arm64');
    const crossBuildPlan = createRuntimeHostPackageSmokePlan({
      platform: 'win32', arch: 'arm64', target: 'nsis', unpackedArtifactPath: unpacked,
      hostPlatform: 'win32', hostArch: 'x64', runNative: true,
    });
    const uncoveredPlan = createRuntimeHostPackageSmokePlan({
      platform: 'win32', arch: 'arm64', target: 'nsis', unpackedArtifactPath: unpacked,
      hostPlatform: 'win32', hostArch: 'x64', runNative: false,
    });

    expect(runRuntimeHostPackageSmoke(crossBuildPlan, {
      spawnSync() {
        throw new Error('cross-build must not execute');
      },
    })).toMatchObject({ execution: 'cross-build', executionDetail: 'not-run-on-host' });
    expect(runRuntimeHostPackageSmoke(uncoveredPlan, {
      spawnSync() {
        throw new Error('uncovered cell must not execute');
      },
    })).toMatchObject({ execution: 'uncovered', executionDetail: 'not-requested' });
  });

  it('does not execute mounted macOS x64 or extracted Linux arm64 package roots on their non-native CI hosts', () => {
    const root = createTempRoot();
    const macUnpacked = createUnpackedArtifact(join(root, 'mac'), 'darwin', 'x64');
    const macMounted = createUnpackedArtifact(join(root, 'mac-mounted'), 'darwin', 'x64');
    const macPackage = join(root, 'MatchaClaw-mac-x64.dmg');
    writeFileSync(macPackage, 'dmg bytes');
    const linuxUnpacked = createUnpackedArtifact(join(root, 'linux'), 'linux', 'arm64');
    const linuxInstalled = createUnpackedArtifact(join(root, 'linux-installed'), 'linux', 'arm64');
    const linuxPackage = join(root, 'MatchaClaw-linux-arm64.deb');
    writeFileSync(linuxPackage, 'deb bytes');
    const macCrossBuildPlan = createRuntimeHostPackageSmokePlan({
      platform: 'darwin', arch: 'x64', target: 'dmg',
      unpackedArtifactPath: macUnpacked,
      packageArtifactPath: macPackage,
      installedArtifactPath: macMounted,
      hostPlatform: 'darwin', hostArch: 'arm64', runNative: true,
    });
    const linuxCrossBuildPlan = createRuntimeHostPackageSmokePlan({
      platform: 'linux', arch: 'arm64', target: 'deb',
      unpackedArtifactPath: linuxUnpacked,
      packageArtifactPath: linuxPackage,
      installedArtifactPath: linuxInstalled,
      hostPlatform: 'linux', hostArch: 'x64', runNative: true,
    });

    for (const plan of [macCrossBuildPlan, linuxCrossBuildPlan]) {
      expect(runRuntimeHostPackageSmoke(plan, {
        spawnSync() {
          throw new Error('cross-build package root must not execute');
        },
      })).toMatchObject({
        execution: 'cross-build',
        executionDetail: 'not-run-on-host',
        packageExecution: 'cross-build',
        packageExecutionDetail: 'not-run-on-host',
      });
    }
  });
});
