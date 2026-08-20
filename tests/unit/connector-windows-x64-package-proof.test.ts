import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..', '..');
const builder = parseYaml(readFileSync(resolve(root, 'electron-builder.yml'), 'utf8')) as {
  win: {
    extraResources: Array<{ from: string; to: string; filter?: string[] }>;
    target: Array<{ target: string; arch: string[] }>;
  };
};
const releaseWorkflow = readFileSync(resolve(root, '.github', 'workflows', 'release.yml'), 'utf8');
const windowsWorkflow = releaseWorkflow.slice(
  releaseWorkflow.indexOf('      # Windows specific steps'),
  releaseWorkflow.indexOf('      # Linux specific steps'),
);
const packageSmoke = readFileSync(resolve(root, 'scripts', 'package-smoke-runtime-host.mjs'), 'utf8');
const packageProof = readFileSync(resolve(root, 'scripts', 'prove-windows-x64-package.mjs'), 'utf8');
const loopbackServer = readFileSync(
  resolve(root, 'runtime-host', 'host', 'src', 'transport', 'provider_models', 'server.rs'),
  'utf8',
);
const connectorTransport = readFileSync(
  resolve(root, 'runtime-host', 'host', 'src', 'transport', 'external_connectors.rs'),
  'utf8',
);

function expectEvery(source: string, fragments: readonly string[]): void {
  for (const fragment of fragments) expect(source).toContain(fragment);
}

describe('Connector O-14 Windows x64 package proof boundary', () => {
  it('pins the Windows x64 package cell to the target-qualified Rust runtime host', () => {
    expect(builder.win.target).toContainEqual({ target: 'nsis', arch: ['x64', 'arm64'] });
    expect(builder.win.extraResources).toContainEqual(expect.objectContaining({
      from: 'runtime-host/dist/win32-${arch}',
      to: 'bin/win32-${arch}',
    }));
  });

  it('requires the Windows x64 release job to install the real NSIS artifact before generic smoke', () => {
    expectEvery(windowsWorkflow, [
      'node scripts/build-runtime-host-native.mjs --platform win32 --arch x64',
      'pnpm exec electron-builder --win --publish never',
      'Prove Windows x64 installed NSIS runtime host',
      'Get-ChildItem -LiteralPath $releaseDirectory -File -Filter \'*-win-x64.exe\'',
      '--platform win32 --arch x64 --target nsis',
      '--package $installer.FullName',
      '--installed $installRoot',
      '--receipt $receiptPath',
      '--nsis-install-duration-ms $nsisInstallDurationMs',
      '--nsis-install-exit-code $nsisInstallExitCode',
      '--run',
      'package-execution=installed-native-run',
      'bootstrap-rejection-passed',
      'WINDOWS_NSIS_EVIDENCE_RECEIPT=$receiptPath',
      'actions/attest-build-provenance@v3',
    ]);
  });

  it('keeps generic runtime-host package smoke from being misreported as Connector proof', () => {
    expect(packageSmoke).not.toContain('external-connectors');
    expect(packageProof).not.toContain('external-connectors');
    expect(windowsWorkflow).not.toContain('external-connectors');
  });

  it('requires Connector package closure to reuse the real Rust TCP loopback fixture', () => {
    expectEvery(loopbackServer, [
      'TcpListener::bind(("127.0.0.1", port))',
      'TcpStream::connect(("127.0.0.1", self.port))',
      'Host::new(host_input(&root))',
      'owner::Owner::spawn(host, events)',
      'Server::bind(0, verifier, owner.handle())',
      'tokio::spawn(server.run())',
      'external_request("externalConnectors.list"',
      'external_decision("externalConnectors.sessionStatus")',
      'loopback_external_connectors_requires_a_fresh_signed_decision_and_redacts_401',
      'loopback_external_connectors_rejects_invalid_identity_without_dispatching',
      'loopback_external_connectors_session_status_distinguishes_native_and_protocol_endpoints',
      'loopback_external_connectors_dispatches_status_and_probe_with_redacted_public_results',
    ]);
    expectEvery(connectorTransport, [
      'pub(crate) const ENDPOINT: &str = "/api/external-connectors"',
      'externalConnectors.list',
      'externalConnectors.sessionStatus',
      'externalConnectors.probe',
    ]);
  });

  it('does not claim a packaged Connector route receipt while the workflow has no Connector execution step', () => {
    expect(windowsWorkflow).toContain('runtime-host-package-evidence-win32-x64-nsis.json');
    expect(windowsWorkflow).not.toContain('connector-package-evidence');
    expect(windowsWorkflow).not.toContain('externalConnectors.sessionStatus');
    expect(windowsWorkflow).not.toContain('externalConnectors.probe');
  });
});
