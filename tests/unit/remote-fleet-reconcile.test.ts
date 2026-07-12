import { describe, expect, it } from 'vitest';
import type { RuntimeScope } from '../../runtime-host/application/agent-runtime/contracts/runtime-address';
import type { CapabilityDescriptor } from '../../runtime-host/application/capabilities/contracts/capability-descriptor';
import type {
  RemoteCapabilitySnapshotRecord,
  RemoteFleetLeaseRecord,
  RemoteRuntimeEndpointRecord,
  RuntimeAgentRecord,
  RuntimeInstanceRecord,
} from '../../runtime-host/application/remote-fleet/remote-fleet-model';
import { buildRemoteFleetReconcilePlan } from '../../runtime-host/application/remote-fleet/remote-fleet-reconcile';
import type { RemoteFleetPersistedState } from '../../runtime-host/application/remote-fleet/remote-fleet-store';

const now = '2026-07-06T00:10:00.000Z';
const runtimeScope: RuntimeScope = {
  kind: 'runtime-instance',
  endpoint: {
    kind: 'native-runtime',
    runtimeAdapterId: 'remote-fleet',
    runtimeInstanceId: 'node-1:openclaw',
  },
};

const descriptor: CapabilityDescriptor = {
  id: 'remote-fleet.runtime-control',
  kind: 'runtime-control',
  scopeKind: 'runtime-instance',
  scope: runtimeScope,
  targetKinds: ['runtime-endpoint'],
  runtimeAdapterId: 'remote-fleet',
  runtimeInstanceId: 'node-1:openclaw',
  supportLevel: 'projected',
  availability: 'available',
  operations: [{ id: 'remoteFleet.runtime.status', title: 'Inspect runtime status', targetKind: 'runtime-endpoint' }],
  policyScope: 'remote-fleet.runtime-control',
  ownerModuleId: 'remote-fleet',
  routeOwnerId: 'remote-fleet',
};

function createPersistedState(overrides: Partial<RemoteFleetPersistedState> = {}): RemoteFleetPersistedState {
  return {
    version: 1,
    connections: [],
    environments: [],
    managedResources: [],
    nodes: [],
    agents: [],
    runtimes: [],
    endpoints: [],
    capabilities: [],
    commands: [],
    leases: [],
    auditEvents: [],
    ...overrides,
  };
}

function createEndpoint(overrides: Partial<RemoteRuntimeEndpointRecord> = {}): RemoteRuntimeEndpointRecord {
  return {
    id: 'node-1:openclaw:endpoint',
    nodeId: 'node-1',
    runtimeId: 'node-1:openclaw',
    endpointRef: {
      kind: 'native-runtime',
      runtimeAdapterId: 'remote-fleet',
      runtimeInstanceId: 'node-1:openclaw',
    },
    scope: runtimeScope,
    protocol: 'remote-fleet',
    labels: [],
    health: { reason: 'ready', lastProbeAt: '2026-07-06T00:00:00.000Z' },
    createdAt: '2026-07-06T00:00:00.000Z',
    updatedAt: '2026-07-06T00:00:00.000Z',
    ...overrides,
  };
}

function createCapability(overrides: Partial<RemoteCapabilitySnapshotRecord> = {}): RemoteCapabilitySnapshotRecord {
  return {
    id: 'node-1:openclaw:endpoint:capabilities',
    nodeId: 'node-1',
    runtimeId: 'node-1:openclaw',
    endpointId: 'node-1:openclaw:endpoint',
    displayName: 'Remote runtime control',
    operationIds: ['remoteFleet.runtime.status'],
    descriptors: [descriptor],
    freshness: {
      reason: 'current',
      observedAt: '2026-07-06T00:09:00.000Z',
      descriptorHash: 'hash-1',
    },
    observedAt: '2026-07-06T00:09:00.000Z',
    ...overrides,
  };
}

function createAgent(overrides: Partial<RuntimeAgentRecord> = {}): RuntimeAgentRecord {
  return {
    id: 'node-1:agent',
    nodeId: 'node-1',
    displayName: 'Node 1 RuntimeAgent',
    enrollment: {
      reason: 'enrolled',
      enrolledAt: '2026-07-06T00:00:00.000Z',
      lastHandshakeAt: '2026-07-06T00:00:00.000Z',
    },
    capabilities: ['remoteFleet.runtime.status'],
    createdAt: '2026-07-06T00:00:00.000Z',
    updatedAt: '2026-07-06T00:00:00.000Z',
    ...overrides,
  };
}

function createRuntime(overrides: Partial<RuntimeInstanceRecord> = {}): RuntimeInstanceRecord {
  return {
    id: 'node-1:openclaw',
    nodeId: 'node-1',
    agentId: 'node-1:agent',
    displayName: 'Node 1 OpenClaw',
    runtimeKind: 'openclaw',
    endpointId: 'node-1:openclaw:endpoint',
    lifecycle: { reason: 'running', startedAt: '2026-07-06T00:00:00.000Z' },
    createdAt: '2026-07-06T00:00:00.000Z',
    updatedAt: '2026-07-06T00:00:00.000Z',
    ...overrides,
  };
}

function createLease(overrides: Partial<RemoteFleetLeaseRecord> = {}): RemoteFleetLeaseRecord {
  return {
    id: 'lease-1',
    endpointId: 'node-1:openclaw:endpoint',
    ownerKind: 'runtime-start',
    ownerId: 'cmd-1',
    state: {
      reason: 'active',
      acquiredAt: '2026-07-06T00:00:00.000Z',
      expiresAt: '2026-07-06T00:09:59.000Z',
    },
    createdAt: '2026-07-06T00:00:00.000Z',
    updatedAt: '2026-07-06T00:00:00.000Z',
    ...overrides,
  };
}

describe('buildRemoteFleetReconcilePlan', () => {
  it('plans descriptor restore and running runtime probe from persisted current endpoint state', () => {
    const plan = buildRemoteFleetReconcilePlan({
      now,
      capabilityStaleAfterMs: 5 * 60_000,
      state: createPersistedState({
        agents: [createAgent()],
        runtimes: [createRuntime()],
        endpoints: [createEndpoint()],
        capabilities: [createCapability()],
      }),
    });

    expect(plan.restoreDescriptors).toEqual([
      {
        reason: 'persisted-current-descriptors',
        targetIds: {
          nodeId: 'node-1',
          runtimeId: 'node-1:openclaw',
          endpointId: 'node-1:openclaw:endpoint',
          capabilityId: 'node-1:openclaw:endpoint:capabilities',
        },
        descriptorCount: 1,
      },
    ]);
    expect(plan.probeAgents).toEqual([
      {
        reason: 'enrolled-agent-needs-post-restore-probe',
        targetIds: {
          nodeId: 'node-1',
          agentId: 'node-1:agent',
        },
      },
    ]);
    expect(plan.reconcileRunningRuntimes).toEqual([
      {
        reason: 'running-runtime-needs-endpoint-probe',
        targetIds: {
          nodeId: 'node-1',
          agentId: 'node-1:agent',
          runtimeId: 'node-1:openclaw',
          endpointId: 'node-1:openclaw:endpoint',
        },
      },
    ]);
  });

  it('plans retired endpoint prune without restoring descriptors for that endpoint', () => {
    const plan = buildRemoteFleetReconcilePlan({
      now,
      capabilityStaleAfterMs: 5 * 60_000,
      state: createPersistedState({
        endpoints: [createEndpoint({ health: { reason: 'retired', retiredAt: '2026-07-06T00:05:00.000Z' } })],
        capabilities: [createCapability()],
      }),
    });

    expect(plan.pruneRetiredEndpoints).toEqual([
      {
        reason: 'retired-endpoint-scope-must-be-pruned',
        targetIds: {
          nodeId: 'node-1',
          runtimeId: 'node-1:openclaw',
          endpointId: 'node-1:openclaw:endpoint',
        },
      },
    ]);
    expect(plan.restoreDescriptors).toEqual([]);
    expect(plan.markStaleCapabilities).toEqual([
      {
        reason: 'capability-endpoint-retired',
        targetIds: {
          nodeId: 'node-1',
          runtimeId: 'node-1:openclaw',
          endpointId: 'node-1:openclaw:endpoint',
          capabilityId: 'node-1:openclaw:endpoint:capabilities',
        },
        observedAt: '2026-07-06T00:09:00.000Z',
      },
    ]);
  });

  it('plans stale capability marking when a current observation exceeds the configured TTL', () => {
    const plan = buildRemoteFleetReconcilePlan({
      now,
      capabilityStaleAfterMs: 60_000,
      state: createPersistedState({
        endpoints: [createEndpoint()],
        capabilities: [createCapability({
          freshness: {
            reason: 'current',
            observedAt: '2026-07-06T00:08:59.000Z',
            descriptorHash: 'hash-1',
          },
          observedAt: '2026-07-06T00:08:59.000Z',
        })],
      }),
    });

    expect(plan.markStaleCapabilities).toEqual([
      {
        reason: 'capability-observation-expired',
        targetIds: {
          nodeId: 'node-1',
          runtimeId: 'node-1:openclaw',
          endpointId: 'node-1:openclaw:endpoint',
          capabilityId: 'node-1:openclaw:endpoint:capabilities',
        },
        observedAt: '2026-07-06T00:08:59.000Z',
      },
    ]);
  });

  it('plans expired lease reaping without changing lease state', () => {
    const expiredLease = createLease();
    const plan = buildRemoteFleetReconcilePlan({
      now,
      capabilityStaleAfterMs: 5 * 60_000,
      state: createPersistedState({ leases: [expiredLease] }),
    });

    expect(plan.reapExpiredLeases).toEqual([
      {
        reason: 'active-lease-expired-before-reconcile',
        targetIds: {
          endpointId: 'node-1:openclaw:endpoint',
          leaseId: 'lease-1',
        },
        expiresAt: '2026-07-06T00:09:59.000Z',
      },
    ]);
    expect(expiredLease.state).toEqual({
      reason: 'active',
      acquiredAt: '2026-07-06T00:00:00.000Z',
      expiresAt: '2026-07-06T00:09:59.000Z',
    });
  });
});
