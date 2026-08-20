import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const projectRoot = process.cwd();
const legacyModulePath = 'runtime-host/composition/modules/remote-fleet-application-module.ts';
const legacyRemoteFleetTree = 'runtime-host/application/remote-fleet';
const forbiddenControlPlaneIdentifiers = [
  'RemoteFleetPort',
  'WorkerBackedRemoteFleetService',
  'remoteFleet.service',
  'remoteFleetModule',
  'registerRemoteFleet',
  'remote_fleet',
  'REMOTE_FLEET_SERVICE_TOKEN',
  'remote-fleet-worker-entry',
  'remote-fleet-routes',
  'remote-fleet-runtime-agent-ingress-route',
  'REMOTE_FLEET_RUNTIME_AGENT_INGRESS_PATH',
  'RemoteReceiptRelay',
];

function collectProductionFiles(root: string): string[] {
  return readdirSync(join(projectRoot, root), { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(projectRoot, root, entry.name);
    if (entry.isDirectory()) return collectProductionFiles(relative(projectRoot, entryPath));
    return entry.isFile()
      && !entryPath.includes(`${join('runtime-host', 'domains', 'fleet', 'src', 'tests')}`)
      && !entryPath.includes(`${join('runtime-host', 'domains', 'fleet', 'src', 'secret_ref', 'tests')}`)
      && !entryPath.includes(`${join('runtime-host', 'domains', 'fleet', 'src', 'store', 'tests')}`)
      && /\.(?:[cm]?[jt]sx?|rs)$/.test(entry.name)
      ? [entryPath]
      : [];
  });
}

describe('O-055 remote Fleet application module deletion', () => {
  it('keeps the historical Remote Fleet module and control-plane tree absent', () => {
    expect(existsSync(join(projectRoot, legacyModulePath))).toBe(false);
    expect(existsSync(join(projectRoot, legacyRemoteFleetTree))).toBe(false);
  });

  it('keeps production Host, Delivery, and Electron sources free of remote control-plane consumers', () => {
    const sources = [
      ...collectProductionFiles('runtime-host').map((path) => readFileSync(path, 'utf8')),
      ...collectProductionFiles('electron').map((path) => readFileSync(path, 'utf8')),
      ...collectProductionFiles('src').map((path) => readFileSync(path, 'utf8')),
    ];

    for (const identifier of forbiddenControlPlaneIdentifiers) {
      expect(sources.some((source) => source.includes(identifier))).toBe(false);
    }
  });

  it('retains Fleet only as a durable local domain without a remote runtime integration', () => {
    const workspaceManifest = readFileSync(join(projectRoot, 'runtime-host', 'Cargo.toml'), 'utf8');
    const fleetManifest = readFileSync(join(projectRoot, 'runtime-host', 'domains', 'fleet', 'Cargo.toml'), 'utf8');

    expect(workspaceManifest).toContain('domains/fleet');
    expect(workspaceManifest).not.toMatch(/remote[-_]fleet/i);
    expect(fleetManifest).toContain('name = "fleet"');
  });
});
