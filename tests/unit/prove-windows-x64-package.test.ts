import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createWindowsX64PackageProofPlan,
  parseWindowsX64PackageProofArgs,
  runWindowsX64PackageProof,
} from '../../scripts/prove-windows-x64-package.mjs';

const tempRoots: string[] = [];

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'matchaclaw-windows-package-proof-'));
  tempRoots.push(root);
  return root;
}

function createPackageRoot(root: string): string {
  const bin = join(root, 'resources', 'bin', 'win32-x64');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'runtime-host.exe'), 'runtime-host');
  writeFileSync(join(bin, 'runtime-host-mcp.exe'), 'runtime-host-mcp');
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Windows x64 package proof command', () => {
  it('requires all absolute artifact inputs and an exact source revision', () => {
    const args = [
      '--unpacked', 'E:/release/win-unpacked',
      '--package', 'E:/release/MatchaClaw-win-x64.exe',
      '--installed', 'E:/temp/installed',
      '--receipt', 'E:/release/local-evidence.json',
      '--source-revision', 'a'.repeat(40),
    ];
    expect(parseWindowsX64PackageProofArgs(args)).toMatchObject({
      unpackedArtifactPath: expect.stringMatching(/win-unpacked$/),
      packageArtifactPath: expect.stringMatching(/MatchaClaw-win-x64\.exe$/),
      sourceRevision: 'a'.repeat(40),
      reuseFunctionalLocalBunCache: false,
    });
    expect(parseWindowsX64PackageProofArgs([...args, '--reuse-functional-local-bun-cache'])).toMatchObject({
      reuseFunctionalLocalBunCache: true,
    });
    expect(() => parseWindowsX64PackageProofArgs([...args.slice(0, 2), ...args.slice(4)])).toThrow(/required options/);
    const relativePackageArgs = [...args];
    relativePackageArgs[3] = 'release/MatchaClaw.exe';
    expect(() => parseWindowsX64PackageProofArgs(relativePackageArgs)).toThrow(/must be absolute/);
    expect(() => parseWindowsX64PackageProofArgs([
      ...args.slice(0, -1), 'bad',
    ])).toThrow(/hexadecimal revision/);
  });

  it('fails before installation when the current host is not Windows x64', () => {
    const plan = {
      unpackedArtifactPath: 'E:/release/win-unpacked',
      packageArtifactPath: 'E:/release/MatchaClaw-win-x64.exe',
      installedArtifactPath: 'E:/temp/installed',
      receiptPath: 'E:/release/local-evidence.json',
      sourceRevision: 'a'.repeat(40),
    };

    if (process.platform !== 'win32' || process.arch !== 'x64') {
      expect(() => createWindowsX64PackageProofPlan(plan)).toThrow(/requires a Windows x64 host/);
    }
  });

  it('installs the NSIS package into a fresh root before smoking the installed runtime-host and writing local receipt', () => {
    const root = createTempRoot();
    const unpacked = createPackageRoot(join(root, 'release', 'win-unpacked'));
    const installed = join(root, 'installed');
    const installer = join(root, 'release', 'MatchaClaw-win-x64.exe');
    const receiptPath = join(root, 'release', 'runtime-host-local-package-evidence-win32-x64-nsis.json');
    mkdirSync(join(root, 'release'), { recursive: true });
    writeFileSync(installer, 'installer');
    const commands: string[] = [];
    const unpackedRuntimeHost = join(unpacked, 'resources', 'bin', 'win32-x64', 'runtime-host.exe');
    const installedRuntimeHost = join(installed, 'resources', 'bin', 'win32-x64', 'runtime-host.exe');

    const result = runWindowsX64PackageProof({
      unpackedArtifactPath: unpacked,
      packageArtifactPath: installer,
      installedArtifactPath: installed,
      receiptPath,
      sourceRevision: 'b'.repeat(40),
    }, {
      spawnSync(command, args) {
        commands.push(command);
        if (command === installer) {
          expect(args).toEqual(['/S', `/D=${installed}`]);
          createPackageRoot(installed);
          return { status: 0, stderr: '' };
        }
        expect([unpackedRuntimeHost, installedRuntimeHost]).toContain(command);
        return { status: 1, stderr: 'runtime-host: runtime-host bootstrap input could not be read\n' };
      },
    });

    expect(commands).toEqual([installer, unpackedRuntimeHost, installedRuntimeHost]);
    expect(result.report).toContain('package-execution=installed-native-run (bootstrap-rejection-passed)');
    expect(result.receiptPath).toBe(receiptPath);
    expect(JSON.parse(readFileSync(receiptPath, 'utf8'))).toMatchObject({
      evidenceType: 'runtime-host-local-package-execution',
      cell: { platform: 'win32', arch: 'x64', target: 'nsis' },
      execution: { kind: 'installed-native-run', oracle: 'bootstrap-rejection', status: 'passed' },
      installation: { scenario: 'fresh-silent-temporary-root', exitCode: 0 },
    });
  });
});
