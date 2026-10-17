import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  copyRuntimeHostNativeBinary,
  createRuntimeHostNativeBuildPlan,
  parseRuntimeHostNativeBuildTargetArgs,
} from '../../scripts/build-runtime-host-native.mjs';

const tempRoots: string[] = [];

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'matchaclaw-runtime-host-native-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('runtime-host native build script', () => {
  it.each([
    ['darwin', 'arm64', 'aarch64-apple-darwin', 'runtime-host'],
    ['darwin', 'x64', 'x86_64-apple-darwin', 'runtime-host'],
    ['linux', 'arm64', 'aarch64-unknown-linux-gnu', 'runtime-host'],
    ['linux', 'x64', 'x86_64-unknown-linux-gnu', 'runtime-host'],
    ['win32', 'arm64', 'aarch64-pc-windows-msvc', 'runtime-host.exe'],
    ['win32', 'x64', 'x86_64-pc-windows-msvc', 'runtime-host.exe'],
  ])('maps %s-%s to its explicit Cargo target and runtime-host artifact', (platform, arch, cargoTarget, binaryName) => {
    const rootDir = createTempRoot();
    const plan = createRuntimeHostNativeBuildPlan({ rootDir, platform, arch });

    expect(plan.cargoTarget).toBe(cargoTarget);
    expect(plan.sourceBinaryPath).toBe(join(rootDir, 'runtime-host', 'target', cargoTarget, 'release', binaryName));
    expect(plan.artifactBinaryPath).toBe(join(rootDir, 'runtime-host', 'dist', `${platform}-${arch}`, binaryName));
    expect(plan.cargoArgs).toEqual([
      'build',
      '--release',
      '--locked',
      '--offline',
      '--manifest-path',
      join(rootDir, 'runtime-host', 'Cargo.toml'),
      '--target',
      cargoTarget,
      '--target-dir',
      join(rootDir, 'runtime-host', 'target'),
      '--package',
      'runtime-host',
      '--bin',
      'runtime-host',
    ]);
    expect(plan).not.toHaveProperty('mcp');
  });

  it.each([
    ['darwin', 'arm64', 'aarch64-apple-darwin'],
    ['darwin', 'x64', 'x86_64-apple-darwin'],
    ['linux', 'arm64', 'aarch64-unknown-linux-gnu'],
    ['linux', 'x64', 'x86_64-unknown-linux-gnu'],
  ])('builds the Unix guardian as a direct Cargo artifact for %s-%s', (platform, arch, cargoTarget) => {
    const rootDir = createTempRoot();
    const plan = createRuntimeHostNativeBuildPlan({ rootDir, platform, arch });

    expect(plan.guardian).toEqual({
      sourceBinaryPath: join(rootDir, 'runtime-host', 'target', cargoTarget, 'release', 'runtime-host-guardian'),
      artifactBinaryPath: join(rootDir, 'runtime-host', 'dist', `${platform}-${arch}`, 'runtime-host-guardian'),
      cargoArgs: [
        'build',
        '--release',
        '--locked',
        '--offline',
        '--manifest-path',
        join(rootDir, 'runtime-host', 'Cargo.toml'),
        '--target',
        cargoTarget,
        '--target-dir',
        join(rootDir, 'runtime-host', 'target'),
        '--package',
        'foundation',
        '--bin',
        'runtime-host-guardian',
      ],
    });
  });

  it.each([
    ['win32', 'arm64'],
    ['win32', 'x64'],
  ])('does not build a Guardian artifact for %s-%s', (platform, arch) => {
    const plan = createRuntimeHostNativeBuildPlan({ rootDir: createTempRoot(), platform, arch });

    expect(plan.guardian).toBeUndefined();
  });

  it('requires exactly one platform and architecture CLI option', () => {
    expect(parseRuntimeHostNativeBuildTargetArgs(['--platform', 'win32', '--arch', 'x64'])).toEqual({
      platform: 'win32',
      arch: 'x64',
    });
    expect(() => parseRuntimeHostNativeBuildTargetArgs([])).toThrow(/required options/);
    expect(() => parseRuntimeHostNativeBuildTargetArgs(['--platform', 'win32'])).toThrow(/required options/);
    expect(() => parseRuntimeHostNativeBuildTargetArgs(['--platform', 'win32', '--platform', 'linux', '--arch', 'x64'])).toThrow(/duplicate option: --platform/);
    expect(() => parseRuntimeHostNativeBuildTargetArgs(['--platform', 'win32', '--arch', 'x64', '--release'])).toThrow(/unexpected argument: --release/);
  });

  it('rejects unsupported platform and architecture combinations', () => {
    expect(() => createRuntimeHostNativeBuildPlan({
      rootDir: createTempRoot(),
      platform: 'freebsd',
      arch: 'x64',
    })).toThrow(/unsupported platform\/architecture: freebsd-x64/);
  });

  it.each(['win32', 'linux'])('copies only the explicit Cargo output and retires the old MCP artifact for %s', (platform) => {
    const rootDir = createTempRoot();
    const plan = createRuntimeHostNativeBuildPlan({ rootDir, platform, arch: 'x64' });
    const artifactDir = dirname(plan.artifactBinaryPath);
    const obsoleteMcp = join(artifactDir, platform === 'win32' ? 'runtime-host-mcp.exe' : 'runtime-host-mcp');
    mkdirSync(dirname(plan.sourceBinaryPath), { recursive: true });
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(plan.sourceBinaryPath, 'native-runtime-host', { encoding: 'utf8', flush: true });
    writeFileSync(obsoleteMcp, 'old-mcp');
    writeFileSync(join(artifactDir, 'unrelated'), 'keep');

    copyRuntimeHostNativeBinary(plan, 'runtime-host');

    expect(readFileSync(plan.artifactBinaryPath, 'utf8')).toBe('native-runtime-host');
    expect(existsSync(obsoleteMcp)).toBe(false);
    expect(readFileSync(join(artifactDir, 'unrelated'), 'utf8')).toBe('keep');
  });

  it('copies the direct Unix guardian Cargo artifact to the same target-qualified directory', () => {
    const rootDir = createTempRoot();
    const plan = createRuntimeHostNativeBuildPlan({ rootDir, platform: 'linux', arch: 'x64' });
    const guardian = plan.guardian!;
    mkdirSync(dirname(guardian.sourceBinaryPath), { recursive: true });
    writeFileSync(guardian.sourceBinaryPath, 'native-runtime-host-guardian', { encoding: 'utf8', flush: true });

    copyRuntimeHostNativeBinary(guardian, 'runtime-host-guardian');

    expect(readFileSync(guardian.artifactBinaryPath, 'utf8')).toBe('native-runtime-host-guardian');
  });

  it('preserves existing artifacts when Cargo did not produce the expected binary', () => {
    const rootDir = createTempRoot();
    const plan = createRuntimeHostNativeBuildPlan({ rootDir, platform: 'linux', arch: 'x64' });
    const obsoleteMcp = join(dirname(plan.artifactBinaryPath), 'runtime-host-mcp');
    mkdirSync(dirname(plan.artifactBinaryPath), { recursive: true });
    writeFileSync(plan.artifactBinaryPath, 'current-host');
    writeFileSync(obsoleteMcp, 'current-mcp');

    expect(() => copyRuntimeHostNativeBinary(plan, 'runtime-host')).toThrow(/Cargo did not produce runtime-host/);
    expect(readFileSync(plan.artifactBinaryPath, 'utf8')).toBe('current-host');
    expect(readFileSync(obsoleteMcp, 'utf8')).toBe('current-mcp');
  });
});
