import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRuntimeHostNativeBuildPlan } from '../../scripts/build-runtime-host-native.mjs';
import { createRuntimeHostPackageSmokePlan, inspectRuntimeHostPackageInventory } from '../../scripts/package-smoke-runtime-host.mjs';

const projectRoot = process.cwd();
const legacyRuntimeHostDirectories = [
  'api',
  'application',
  'bootstrap',
  'composition',
  'core',
  'openclaw-bridge',
  'plugin-engine',
  'services',
  'shared',
];
const forbiddenLegacyReferences = [
  'runtime-host/api/',
  'runtime-host/application/',
  'runtime-host/bootstrap/',
  'runtime-host/composition/',
  'runtime-host/core/',
  'runtime-host/openclaw-bridge/',
  'runtime-host/plugin-engine/',
  'runtime-host/services/',
  'main-cli.js',
  'host-process.cjs',
];
const legacyDispatchPaths = [
  'runtime-host/api/dispatch/dispatch-envelope.ts',
  'runtime-host/api/dispatch/dispatch-route-handler.ts',
  'runtime-host/api/dispatch/runtime-route-dispatcher-types.ts',
  'runtime-host/api/dispatch/runtime-route-dispatcher.ts',
  'runtime-host/api/dispatch/runtime-route-index.ts',
];
const forbiddenGenericDispatchIdentifiers = [
  'parseDispatchEnvelope',
  'handleDispatchRoute',
  'dispatchRuntimeHostRoute',
  'invokeRuntimeCapability',
  'buildRuntimeInvokeCommand',
  'runSystemRuntimeMcpStdioServer',
  'runtime invoke',
  'system-runtime mcp-stdio',
];

function collectFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(root, entry.name);
    if (entry.isDirectory()) return collectFiles(entryPath);
    return entry.isFile() ? [entryPath] : [];
  });
}

function productionSource(root: string): readonly string[] {
  return collectFiles(join(projectRoot, root))
    .filter((path) => /\.(?:[cm]?[jt]sx?|rs)$/.test(path))
    .map((path) => readFileSync(path, 'utf8'));
}

describe('runtime-host legacy entrypoint attestation', () => {
  it('keeps every deleted TypeScript runtime-host owner absent', () => {
    for (const directory of legacyRuntimeHostDirectories) {
      expect(existsSync(join(projectRoot, 'runtime-host', directory))).toBe(false);
    }

    const runtimeHostSource = collectFiles(join(projectRoot, 'runtime-host'))
      .filter((path) => /\.(?:[cm]?[jt]sx?)$/.test(path));
    expect(runtimeHostSource).toEqual([]);
  });

  it('keeps Electron, Renderer, and OpenClaw CLI production sources disconnected from deleted owners', () => {
    const sources = [
      ...productionSource('electron'),
      ...productionSource('src'),
    ];

    for (const reference of forbiddenLegacyReferences) {
      expect(sources.some((source) => source.includes(reference))).toBe(false);
    }
  });

  it('keeps the deleted generic dispatch envelope unreachable from supported roots', () => {
    for (const legacyPath of legacyDispatchPaths) {
      expect(existsSync(join(projectRoot, legacyPath))).toBe(false);
    }

    const sources = [
      ...productionSource('electron'),
      ...productionSource('src'),
      ...productionSource('runtime-host'),
    ];
    for (const identifier of forbiddenGenericDispatchIdentifiers) {
      expect(sources.some((source) => source.includes(identifier))).toBe(false);
    }
  });

  it('keeps the supported host and MCP command entrypoints native', () => {
    const hostMain = readFileSync(join(projectRoot, 'runtime-host', 'host', 'src', 'main.rs'), 'utf8');
    const mcpMain = readFileSync(join(projectRoot, 'runtime-host', 'host', 'src', 'bin', 'runtime-host-mcp.rs'), 'utf8');
    const hostManifest = readFileSync(join(projectRoot, 'runtime-host', 'host', 'Cargo.toml'), 'utf8');

    expect(hostMain).toContain('async fn main() -> ExitCode');
    expect(mcpMain).toContain('fn main() -> ExitCode');
    expect(mcpMain).toContain('runtime_host::run_team_run_mcp');
    expect(hostManifest).toContain('name = "runtime-host"');
    expect(hostManifest).toContain('name = "runtime-host-mcp"');
    for (const reference of forbiddenLegacyReferences) {
      expect(hostMain.includes(reference) || mcpMain.includes(reference)).toBe(false);
    }
  });

  it('requires exactly the Windows x64 Rust host and MCP artifacts in the target-qualified layout', () => {
    const build = createRuntimeHostNativeBuildPlan({
      rootDir: projectRoot,
      platform: 'win32',
      arch: 'x64',
    });
    expect(build.cargoTarget).toBe('x86_64-pc-windows-msvc');
    expect(relative(projectRoot, build.artifactBinaryPath)).toBe(join('runtime-host', 'dist', 'win32-x64', 'runtime-host.exe'));
    expect(relative(projectRoot, build.mcp.artifactBinaryPath)).toBe(join('runtime-host', 'dist', 'win32-x64', 'runtime-host-mcp.exe'));
    expect(build.guardian).toBeUndefined();

    const packaged = createRuntimeHostPackageSmokePlan({
      platform: 'win32',
      arch: 'x64',
      target: 'nsis',
      unpackedArtifactPath: join(projectRoot, 'release', 'win-unpacked'),
    });
    expect(relative(projectRoot, packaged.runtimeHostPath)).toBe(join('release', 'win-unpacked', 'resources', 'bin', 'win32-x64', 'runtime-host.exe'));
    expect(relative(projectRoot, packaged.runtimeHostMcpPath)).toBe(join('release', 'win-unpacked', 'resources', 'bin', 'win32-x64', 'runtime-host-mcp.exe'));
    expect(packaged.guardianPath.endsWith('runtime-host-guardian')).toBe(true);
    expect(() => inspectRuntimeHostPackageInventory(packaged, {
      isDirectory: (path) => !path.endsWith('runtime-host-guardian') && !path.endsWith('runtime-host-mcp.exe'),
      isFile: (path) => path.endsWith('runtime-host.exe'),
      readDirectory: () => [],
    })).toThrow(/runtime-host-mcp artifact/);
  });
});
