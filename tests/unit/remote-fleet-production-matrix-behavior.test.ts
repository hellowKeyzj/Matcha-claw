import { describe, expect, it } from 'vitest';
import { AgentRuntimeRegistry } from '../../runtime-host/application/agent-runtime/contracts/agent-runtime-registry';
import type { RuntimeEndpointRef, RuntimeScope, TeamRunScope } from '../../runtime-host/application/agent-runtime/contracts/runtime-address';
import type { CapabilityDescriptor } from '../../runtime-host/application/capabilities/contracts/capability-descriptor';
import {
  REMOTE_FLEET_SECRET_HOST_RPC_METHOD,
  REMOTE_FLEET_SECRET_HOST_RPC_RESULT_TYPE,
  REMOTE_FLEET_SECRET_RESOLVE_PURPOSE,
  buildRemoteFleetCommandDispatchEnvelope,
  buildRuntimeLaunchCommandRequest,
  dispatchRemoteFleetHostRequest,
  readRemoteFleetSecret,
  selectRemoteFleetEndpoint,
} from '../../runtime-host/application/remote-fleet';
import type {
  RemoteFleetCommandRecord,
  RemoteFleetLeaseRecord,
  RemoteFleetNodeRecord,
  RemoteFleetSecretRef,
  RemoteRuntimeEndpointRecord,
  RuntimeInstanceRecord,
} from '../../runtime-host/application/remote-fleet/remote-fleet-model';

const now = '2026-07-06T10:00:00.000Z';
const endpointRef: RuntimeEndpointRef = {
  kind: 'native-runtime',
  runtimeAdapterId: 'remote-fleet',
  runtimeInstanceId: 'node-1:openclaw',
};
const runtimeScope: RuntimeScope = {
  kind: 'runtime-instance',
  endpoint: endpointRef,
};

function nodeRecord(overrides: Partial<RemoteFleetNodeRecord> = {}): RemoteFleetNodeRecord {
  return {
    id: 'node-1',
    displayName: 'Node 1',
    targetKind: 'container',
    labels: ['linux'],
    enabled: true,
    publicConfig: {},
    secretRefs: {},
    health: { reason: 'online', lastSeenAt: now },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function runtimeRecord(overrides: Partial<RuntimeInstanceRecord> = {}): RuntimeInstanceRecord {
  return {
    id: 'node-1:openclaw',
    nodeId: 'node-1',
    agentId: 'node-1:agent',
    displayName: 'Node 1 OpenClaw',
    runtimeKind: 'openclaw',
    endpointId: 'node-1:openclaw:endpoint',
    lifecycle: { reason: 'running', startedAt: now },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function endpointRecord(overrides: Partial<RemoteRuntimeEndpointRecord> = {}): RemoteRuntimeEndpointRecord {
  return {
    id: 'node-1:openclaw:endpoint',
    nodeId: 'node-1',
    runtimeId: 'node-1:openclaw',
    endpointRef,
    scope: runtimeScope,
    protocol: 'remote-fleet',
    labels: ['linux'],
    health: { reason: 'ready', lastProbeAt: now },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function commandRecord(overrides: Partial<RemoteFleetCommandRecord> = {}): RemoteFleetCommandRecord {
  return {
    id: 'command-1',
    idempotencyKey: 'idem:command-1',
    nodeId: 'node-1',
    agentId: 'node-1:agent',
    runtimeId: 'node-1:openclaw',
    endpointId: 'node-1:openclaw:endpoint',
    command: 'start-runtime',
    state: { reason: 'queued', queuedAt: now },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function capabilityDescriptor(overrides: Partial<CapabilityDescriptor> = {}): CapabilityDescriptor {
  return {
    id: 'remote-fleet.runtime-control',
    kind: 'runtime-control',
    scopeKind: runtimeScope.kind,
    scope: runtimeScope,
    targetKinds: ['runtime-endpoint'],
    runtimeAdapterId: 'remote-fleet',
    runtimeInstanceId: 'node-1:openclaw',
    supportLevel: 'projected',
    availability: 'available',
    operations: [{ id: 'remoteFleet.runtime.start', title: 'Start runtime', targetKind: 'runtime-endpoint' }],
    policyScope: 'remote-fleet.runtime-control',
    ownerModuleId: 'remote-fleet',
    routeOwnerId: 'remote-fleet',
    ...overrides,
  };
}

function activeLease(input: { id: string; endpointId?: string; ownerKind?: RemoteFleetLeaseRecord['ownerKind']; expiresAt?: string }): RemoteFleetLeaseRecord {
  return {
    id: input.id,
    endpointId: input.endpointId ?? 'node-1:openclaw:endpoint',
    ownerKind: input.ownerKind ?? 'team-run',
    ownerId: `${input.id}:owner`,
    state: { reason: 'active', acquiredAt: now, expiresAt: input.expiresAt ?? '2026-07-06T10:05:00.000Z' },
    createdAt: now,
    updatedAt: now,
  };
}

describe('Remote Fleet production matrix behavior contracts', () => {
  it('dispatches worker host transport through the real capability registry endpoint-scope replace and prune ports', async () => {
    const registry = new AgentRuntimeRegistry();
    const descriptor = capabilityDescriptor();

    await expect(dispatchRemoteFleetHostRequest({
      type: 'host.capability.replaceForEndpointScope',
      requestId: 'host-rpc-1',
      scope: runtimeScope,
      descriptors: [descriptor],
    }, { capabilityRegistry: registry })).resolves.toEqual({ success: true });

    expect(registry.getCapability({ id: descriptor.id, scope: runtimeScope })).toEqual(descriptor);
    expect(registry.listCapabilities().map((candidate) => candidate.id)).toEqual(['remote-fleet.runtime-control']);

    await expect(dispatchRemoteFleetHostRequest({
      type: 'host.capability.pruneEndpointScope',
      requestId: 'host-rpc-2',
      scope: runtimeScope,
    }, { capabilityRegistry: registry })).resolves.toEqual({ success: true });

    expect(registry.listCapabilities()).toEqual([]);
  });

  it('propagates runtime launch validation failures through the command dispatch envelope instead of building an unsafe start request', () => {
    const node = nodeRecord({
      publicConfig: {
        runtimeLaunch: {
          env: { lowerCase: 'bad' },
          secretEnv: { ANTHROPIC_API_KEY: 'missingAnthropicKey' },
          ports: [{ name: 'bad-port', targetPort: 70_000, protocol: 'smtp', exposure: 'internet' }],
        },
      },
      secretRefs: {},
    });
    const runtime = runtimeRecord();
    const endpoint = endpointRecord();

    const launchResult = buildRuntimeLaunchCommandRequest({ commandId: 'command-1', node, runtime });
    expect(launchResult.resultType).toBe('invalid');
    if (launchResult.resultType !== 'invalid') return;
    expect(launchResult.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'runtimeLaunch.env.lowerCase', reason: 'invalid-value' }),
      expect.objectContaining({ path: 'runtimeLaunch.secretEnv.ANTHROPIC_API_KEY', reason: 'missing-secret-ref' }),
      expect.objectContaining({ path: 'runtimeLaunch.ports.0.targetPort', reason: 'invalid-value' }),
    ]));

    const dispatchResult = buildRemoteFleetCommandDispatchEnvelope({ command: commandRecord(), node, runtime, endpoint });
    expect(dispatchResult).toMatchObject({
      resultType: 'invalid',
      commandName: 'start-runtime',
      issues: expect.arrayContaining([
        expect.objectContaining({ reason: 'invalid-launch-spec', path: 'runtimeLaunch.env.lowerCase' }),
        expect.objectContaining({ reason: 'invalid-launch-spec', path: 'runtimeLaunch.secretEnv.ANTHROPIC_API_KEY' }),
        expect.objectContaining({ reason: 'invalid-launch-spec', path: 'runtimeLaunch.ports.0.targetPort' }),
      ]),
    });
    expect(dispatchResult).not.toHaveProperty('envelope');
  });

  it('keeps secret resolution on secret refs across connector lookup and worker host RPC without leaking through durable projections', async () => {
    const secretRef: RemoteFleetSecretRef = { kind: 'secret-ref', ref: 'remote-fleet://node-1/anthropic' };
    const readRefs: RemoteFleetSecretRef[] = [];
    const connectorLookup = await readRemoteFleetSecret({
      name: 'anthropicApiKey',
      secretRefs: { anthropicApiKey: secretRef },
      secrets: {
        readSecret: async (ref) => {
          readRefs.push(ref);
          return { resultType: 'found', value: 'sk-live-secret-value' };
        },
      },
    });

    expect(connectorLookup).toEqual({ resultType: 'found', value: 'sk-live-secret-value' });
    expect(readRefs).toEqual([secretRef]);

    const resolveSecret = async (input: { readonly secretRef: string }) => ({
      resultType: 'resolved' as const,
      secretRef: input.secretRef,
      plaintextSecretValue: 'sk-live-secret-value',
    });
    const hostResult = await dispatchRemoteFleetHostRequest({
      type: REMOTE_FLEET_SECRET_HOST_RPC_METHOD,
      requestId: 'secret-rpc-1',
      input: {
        secretRef: secretRef.ref,
        purpose: REMOTE_FLEET_SECRET_RESOLVE_PURPOSE,
        commandExecutionId: 'command-1',
        workerId: 'remote-fleet-worker-1',
      },
    }, { secretResolver: { resolveSecret } });

    expect(hostResult).toEqual({
      type: REMOTE_FLEET_SECRET_HOST_RPC_RESULT_TYPE,
      requestId: 'secret-rpc-1',
      resultType: 'resolved',
      secretRef: secretRef.ref,
      plaintextSecretValue: 'sk-live-secret-value',
    });

    const durableLaunchRequest = buildRuntimeLaunchCommandRequest({
      commandId: 'command-1',
      runtime: runtimeRecord(),
      node: nodeRecord({
        publicConfig: { runtimeLaunch: { secretEnv: { ANTHROPIC_API_KEY: 'anthropicApiKey' } } },
        secretRefs: { anthropicApiKey: secretRef },
      }),
    });
    expect(durableLaunchRequest.resultType).toBe('built');
    if (durableLaunchRequest.resultType !== 'built') return;
    expect(durableLaunchRequest.request.publicConfig).toEqual({
      runtimeLaunch: expect.objectContaining({
        environment: {
          public: [],
          secrets: [{ name: 'ANTHROPIC_API_KEY', secretRefName: 'anthropicApiKey', placeholder: '{{remote-fleet.secret-env.ANTHROPIC_API_KEY}}' }],
        },
      }),
    });
    expect(JSON.stringify(durableLaunchRequest.request.publicConfig)).not.toContain('sk-live-secret-value');
  });

  it('lets TeamRun consume only current Remote Fleet endpoint capabilities and lease capacity without owning Remote Fleet state', () => {
    const teamRunScope: TeamRunScope = {
      kind: 'team-run',
      endpoint: endpointRef,
      teamId: 'team-1',
      runId: 'run-1',
    };
    const registry = new AgentRuntimeRegistry();
    const runtimeDescriptor = capabilityDescriptor();
    registry.replaceForRuntimeEndpointScope(runtimeScope, [runtimeDescriptor]);

    const teamRunDescriptor = registry.getCapability({ id: runtimeDescriptor.id, scope: teamRunScope });
    expect(teamRunDescriptor).toEqual({
      ...runtimeDescriptor,
      scopeKind: 'team-run',
      scope: teamRunScope,
    });
    expect(registry.listCapabilities()).toEqual([runtimeDescriptor]);

    const selection = selectRemoteFleetEndpoint({
      endpoints: [endpointRecord()],
      runtimes: [runtimeRecord()],
      capabilities: [{
        id: 'node-1:openclaw:endpoint:capabilities',
        nodeId: 'node-1',
        runtimeId: 'node-1:openclaw',
        endpointId: 'node-1:openclaw:endpoint',
        displayName: 'Remote runtime control',
        operationIds: ['remoteFleet.runtime.start', 'sessions.prompt'],
        descriptors: [runtimeDescriptor],
        freshness: { reason: 'current', observedAt: now, descriptorHash: 'hash-1' },
        observedAt: now,
      }],
      leases: [
        activeLease({ id: 'lease-existing-team-run', ownerKind: 'team-run' }),
        activeLease({ id: 'lease-expired-team-run', ownerKind: 'team-run', expiresAt: '2026-07-06T09:59:00.000Z' }),
      ],
      requiredRuntimeKind: 'openclaw',
      requiredLabels: ['linux'],
      requiredOperationIds: ['sessions.prompt'],
      maxActiveLeases: 2,
      nowMs: Date.parse(now),
    });

    expect(selection.primary).toMatchObject({
      endpointId: 'node-1:openclaw:endpoint',
      runtimeId: 'node-1:openclaw',
      runtimeKind: 'openclaw',
      activeLeaseCount: 1,
      maxActiveLeaseCount: 2,
      matchedOperationIds: ['remoteFleet.runtime.start', 'sessions.prompt'],
    });
    expect(selection.selectionReason).toMatchObject({
      resultType: 'selected',
      primaryEndpointId: 'node-1:openclaw:endpoint',
      eligibleEndpointIds: ['node-1:openclaw:endpoint'],
      excludedEndpoints: [],
    });
  });

  it('closes retired endpoints out of the ops matrix by pruning capabilities and excluding the endpoint from downstream routing', async () => {
    const registry = new AgentRuntimeRegistry();
    const descriptor = capabilityDescriptor();
    registry.replaceForRuntimeEndpointScope(runtimeScope, [descriptor]);

    await dispatchRemoteFleetHostRequest({
      type: 'host.capability.pruneEndpointScope',
      requestId: 'host-rpc-retire-1',
      scope: runtimeScope,
    }, { capabilityRegistry: registry });

    const selection = selectRemoteFleetEndpoint({
      endpoints: [endpointRecord({ health: { reason: 'retired', retiredAt: now } })],
      runtimes: [runtimeRecord()],
      capabilities: [{
        id: 'node-1:openclaw:endpoint:capabilities',
        nodeId: 'node-1',
        runtimeId: 'node-1:openclaw',
        endpointId: 'node-1:openclaw:endpoint',
        displayName: 'Remote runtime control',
        operationIds: [],
        descriptors: [],
        freshness: { reason: 'pruned', prunedAt: now },
      }],
      leases: [activeLease({ id: 'lease-released-after-retire', ownerKind: 'runtime-start' })],
      requiredOperationIds: ['sessions.prompt'],
      nowMs: Date.parse(now),
    });

    expect(registry.listCapabilities()).toEqual([]);
    expect(selection.primary).toBeNull();
    expect(selection.selectionReason).toMatchObject({
      resultType: 'no-eligible-endpoint',
      evaluatedEndpointIds: ['node-1:openclaw:endpoint'],
      eligibleEndpointIds: [],
      excludedEndpoints: [{
        endpointId: 'node-1:openclaw:endpoint',
        reasons: [
          { reason: 'endpoint-retired', retiredAt: now },
          { reason: 'capability-pruned', snapshotIds: ['node-1:openclaw:endpoint:capabilities'] },
        ],
      }],
    });
  });
});
