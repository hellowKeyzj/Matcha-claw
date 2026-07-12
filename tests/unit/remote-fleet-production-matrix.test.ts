import { existsSync, readFileSync, readdirSync } from 'node:fs';
import runtimeHostProcessTsconfig from '../../tsconfig.runtime-host-process.json';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentRuntimeRegistry } from '../../runtime-host/application/agent-runtime/contracts/agent-runtime-registry';
import { readRemoteFleetSecret } from '../../runtime-host/application/remote-fleet';
import type { RemoteFleetSecretRef } from '../../runtime-host/application/remote-fleet/remote-fleet-model';

const repositoryRoot = process.cwd();

const remoteFleetWorkerContractsPath = sourcePath('runtime-host/application/remote-fleet/remote-fleet-worker-contracts.ts');
const remoteFleetWorkerClientPath = sourcePath('runtime-host/application/remote-fleet/remote-fleet-worker-client.ts');
const remoteFleetRuntimePath = sourcePath('runtime-host/application/remote-fleet/remote-fleet-runtime.ts');
const remoteFleetApplicationModulePath = sourcePath('runtime-host/composition/modules/remote-fleet-application-module.ts');
const remoteFleetWorkerEntryRelativePath = 'runtime-host/application/remote-fleet/infrastructure/worker/remote-fleet-worker-entry.ts';
const remoteFleetWorkerEntryPath = sourcePath(remoteFleetWorkerEntryRelativePath);
const remoteFleetConnectorsPath = sourcePath('runtime-host/application/remote-fleet/remote-fleet-connectors.ts');
const agentRuntimeRegistryPath = sourcePath('runtime-host/application/agent-runtime/contracts/agent-runtime-registry.ts');
const rendererRemoteFleetStorePath = sourcePath('src/stores/remote-fleet.ts');
const teamRuntimeRoot = sourcePath('runtime-host/application/team-runtime');
const teamCapabilityRoot = sourcePath('runtime-host/application/capabilities/team');
const allowedTeamRunRemoteFleetCouplings = new Set([
  'runtime-host/application/team-runtime/adapters/remote-fleet-team-endpoint-selector-adapter.ts',
]);

function sourcePath(relativePath: string): string {
  return join(repositoryRoot, relativePath);
}

function readSource(filePath: string): string {
  return readFileSync(filePath, 'utf8');
}

function extractSourceBlock(source: string, startMarker: string, endMarker: string): string {
  const startIndex = source.indexOf(startMarker);
  if (startIndex < 0) {
    throw new Error(`Source marker not found: ${startMarker}`);
  }
  const endIndex = source.indexOf(endMarker, startIndex + startMarker.length);
  if (endIndex < 0) {
    throw new Error(`Source marker not found: ${endMarker}`);
  }
  return source.slice(startIndex, endIndex);
}

function listTypeScriptFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(root, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(entryPath);
    return entry.isFile() && entry.name.endsWith('.ts') ? [entryPath] : [];
  });
}

function toRepositoryRelativePath(filePath: string): string {
  return relative(repositoryRoot, filePath).replace(/\\/g, '/');
}

describe('Remote Fleet production matrix contracts', () => {
  it('keeps the worker host RPC contract explicit for capability replace, prune, RuntimeAgent dispatch, and bootstrap dispatch', () => {
    const workerContractsSource = readSource(remoteFleetWorkerContractsPath);
    const workerClientSource = readSource(remoteFleetWorkerClientPath);
    const runtimeSource = readSource(remoteFleetRuntimePath);
    const workerEntrySource = readSource(remoteFleetWorkerEntryPath);

    expect(workerContractsSource).toContain("readonly type: 'host.capability.replaceForEndpointScope'");
    expect(workerContractsSource).toContain('readonly descriptors: readonly CapabilityDescriptor[]');
    expect(workerContractsSource).toContain("readonly type: 'host.capability.pruneEndpointScope'");
    expect(workerContractsSource).toContain('readonly scope: RuntimeScope');
    expect(workerContractsSource).toContain("readonly type: 'host.runtimeAgent.dispatchCommand'");
    expect(workerContractsSource).toContain('readonly envelope: RemoteFleetCommandDispatchEnvelope');
    expect(workerContractsSource).toContain("readonly type: 'host.remoteFleetBootstrap.dispatchCommand'");
    expect(workerContractsSource).toContain('readonly envelope: RemoteFleetBootstrapCommandEnvelope');

    expect(runtimeSource).toContain("type: 'host.capability.replaceForEndpointScope'");
    expect(runtimeSource).toContain("type: 'host.capability.pruneEndpointScope'");
    expect(runtimeSource).toContain("type: 'host.runtimeAgent.dispatchCommand'");
    expect(runtimeSource).toContain("type: 'host.remoteFleetBootstrap.dispatchCommand'");
    expect(runtimeSource).toContain('buildRemoteFleetCommandDispatchEnvelope');
    expect(runtimeSource).toContain('createRemoteFleetBootstrapCommandEnvelope');
    expect(workerEntrySource).toContain('RemoteFleetHostRequestWithoutId');
    expect(workerEntrySource).toContain('parentPort!.postMessage({ ...request, requestId }');

    expect(workerClientSource).toContain("case 'host.capability.replaceForEndpointScope'");
    expect(workerClientSource).toContain('replaceForRuntimeEndpointScope(message.scope, message.descriptors)');
    expect(workerClientSource).toContain("case 'host.capability.pruneEndpointScope'");
    expect(workerClientSource).toContain('removeForRuntimeEndpointScope(message.scope)');
    expect(workerClientSource).toContain("case 'host.runtimeAgent.dispatchCommand'");
    expect(workerClientSource).toContain('runtimeAgentDispatcher.dispatchCommand(envelope)');
    expect(workerClientSource).toContain("resultType: 'unavailable', accepted: false");
    expect(workerClientSource).toContain("case 'host.remoteFleetBootstrap.dispatchCommand'");
    expect(workerClientSource).toContain('bootstrapDispatcher.dispatchCommand(envelope)');
  });

  it('keeps the connector seam on secret refs instead of public runtime config secrets', async () => {
    const connectorSource = readSource(remoteFleetConnectorsPath);
    const secretRef: RemoteFleetSecretRef = { kind: 'secret-ref', ref: 'remote-fleet://node/ssh-key' };
    const readRefs: RemoteFleetSecretRef[] = [];

    const found = await readRemoteFleetSecret({
      name: 'sshPrivateKey',
      secretRefs: { sshPrivateKey: secretRef },
      secrets: {
        readSecret: async (ref) => {
          readRefs.push(ref);
          return { resultType: 'found', value: 'redacted-secret-value' };
        },
      },
    });
    const missing = await readRemoteFleetSecret({
      name: 'apiToken',
      secretRefs: {},
      secrets: {
        readSecret: async () => {
          throw new Error('missing secret refs should not call the secret reader');
        },
      },
    });

    expect(connectorSource).toContain('readonly secretRefs: Readonly<Record<string, RemoteFleetSecretRef>>');
    expect(connectorSource).toContain('readonly secrets: RemoteFleetSecretReader');
    expect(connectorSource).toContain('readSecret(ref: RemoteFleetSecretRef)');
    expect(readRefs).toEqual([secretRef]);
    expect(found).toEqual({ resultType: 'found', value: 'redacted-secret-value' });
    expect(missing).toEqual({ resultType: 'missing', ref: 'apiToken' });
  });

  it('exposes endpoint-scope replacement and removal through AgentRuntimeRegistry', () => {
    const registry = new AgentRuntimeRegistry();
    const registrySource = readSource(agentRuntimeRegistryPath);

    expect(typeof registry.replaceForRuntimeEndpointScope).toBe('function');
    expect(typeof registry.removeForRuntimeEndpointScope).toBe('function');
    expect(registrySource).toContain('replaceForRuntimeEndpointScope(scope: RuntimeScope, descriptors: Iterable<CapabilityDescriptor>): void');
    expect(registrySource).toContain('this.capabilities.replaceForRuntimeEndpointScope(scope, descriptors)');
    expect(registrySource).toContain('removeForRuntimeEndpointScope(scope: RuntimeScope): void');
    expect(registrySource).toContain('this.capabilities.removeForRuntimeEndpointScope(scope)');
  });

  it('keeps production Remote Fleet wiring worker-backed with no in-process fallback', () => {
    const applicationModuleSource = readSource(remoteFleetApplicationModulePath);
    const workerClientSource = readSource(remoteFleetWorkerClientPath);
    const workerEntrySource = readSource(remoteFleetWorkerEntryPath);
    const productionSources = [
      { path: remoteFleetApplicationModulePath, text: applicationModuleSource },
      { path: remoteFleetWorkerClientPath, text: workerClientSource },
      { path: remoteFleetWorkerEntryPath, text: workerEntrySource },
    ];
    const fallbackPattern = /InProcessRemoteFleet|createInProcessRemoteFleet|in[-_ ]process\s+fallback|fallback[^\n]{0,80}(remote[-_ ]fleet|RemoteFleet)|RemoteFleetRuntime[^\n]{0,80}fallback/i;

    expect(applicationModuleSource).toContain('new WorkerBackedRemoteFleetService');
    expect(applicationModuleSource).toContain('remote-fleet-worker-entry.js');
    expect(runtimeHostProcessTsconfig.include).toContain(remoteFleetWorkerEntryRelativePath);
    expect(applicationModuleSource).not.toContain("from '../../application/remote-fleet/remote-fleet-runtime'");
    expect(applicationModuleSource).not.toContain('new RemoteFleetRuntime');
    expect(workerClientSource).toContain('new Worker(deps.workerScriptPath');
    expect(workerEntrySource).toContain('new RemoteFleetRuntime({');
    expect(workerEntrySource).toContain('host: { request: requestHost }');
    expect(workerEntrySource).toContain('new FileRemoteFleetStateStore');

    const fallbackSources = productionSources
      .filter((file) => fallbackPattern.test(file.text))
      .map((file) => toRepositoryRelativePath(file.path));
    expect(fallbackSources).toEqual([]);
  });

  it('removes public enrollment token state and actions while retaining agent lifecycle actions', () => {
    const rendererStoreSource = readSource(rendererRemoteFleetStorePath);
    const stateContract = extractSourceBlock(
      rendererStoreSource,
      'type RemoteFleetState = {',
      '\n};\n\nasync function remoteFleetPost',
    );

    expect(rendererStoreSource).not.toContain('issueEnrollmentToken');
    expect(rendererStoreSource).not.toContain('enrollmentToken');
    expect(stateContract).toContain('readonly install: (nodeId: string) => Promise<RemoteFleetActionPayload>;');
    expect(stateContract).toContain('readonly revoke: (agentId: string) => Promise<RemoteFleetActionPayload>;');
  });

  it('keeps TeamRun Remote Fleet coupling limited to the downstream selector adapter', () => {
    const teamRunSources = [
      ...listTypeScriptFiles(teamRuntimeRoot),
      ...listTypeScriptFiles(teamCapabilityRoot),
    ];
    const remoteFleetCouplingPattern = /RemoteFleet|remoteFleet|remote-fleet|remote fleet|Remote Fleet|enrollmentToken/i;
    const unexpectedCoupledFiles = teamRunSources
      .filter((filePath) => remoteFleetCouplingPattern.test(readSource(filePath)))
      .map(toRepositoryRelativePath)
      .filter((filePath) => !allowedTeamRunRemoteFleetCouplings.has(filePath));

    expect(teamRunSources.length).toBeGreaterThan(0);
    expect(unexpectedCoupledFiles).toEqual([]);
  });
});
