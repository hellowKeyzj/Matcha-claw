import { describe, expect, it } from 'vitest';
import {
  buildRemoteFleetMetricsSnapshot,
  type RemoteFleetMetricsSnapshotInput,
} from '../../runtime-host/application/remote-fleet/remote-fleet-metrics';
import type {
  RemoteCapabilitySnapshotRecord,
  RemoteFleetAuditEventRecord,
  RemoteFleetCommandRecord,
  RemoteFleetEnvironmentRecord,
  RemoteFleetLeaseRecord,
  RemoteFleetManagedResourceRecord,
  RemoteFleetNodeRecord,
  RemoteRuntimeEndpointRecord,
  RuntimeAgentRecord,
  RuntimeInstanceRecord,
} from '../../runtime-host/application/remote-fleet/remote-fleet-model';

const emptyMetricsInput: RemoteFleetMetricsSnapshotInput = {
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
};

describe('buildRemoteFleetMetricsSnapshot', () => {
  it('returns stable zero-valued buckets for an empty fleet', () => {
    const metrics = buildRemoteFleetMetricsSnapshot(emptyMetricsInput);

    expect(metrics.environments).toEqual({
      totalCount: 0,
      countByStatus: { registered: 0, deploying: 0, ready: 0, deleting: 0, deleted: 0, orphaned: 0, failed: 0 },
    });
    expect(metrics.managedResources).toEqual({
      totalCount: 0,
      countByStatus: { observed: 0, provisioning: 0, ready: 0, deleting: 0, deleted: 0, conflict: 0, failed: 0 },
    });
    expect(metrics.nodes).toEqual({
      totalCount: 0,
      countByStatus: { unknown: 0, online: 0, offline: 0, disabled: 0, error: 0 },
      countByTargetKind: { 'ssh-host': 0, container: 0, vm: 0, 'k8s-pod': 0, custom: 0 },
    });
    expect(metrics.runtimes.countByRuntimeKind).toEqual({ openclaw: 0, 'matcha-agent': 0, 'plugin-runtime': 0 });
    expect(metrics.endpoints.drainingEndpoints).toEqual([]);
    expect(metrics.endpoints.retiredEndpoints).toEqual([]);
    expect(metrics.capabilities.staleCount).toBe(0);
    expect(metrics.commands.recentFailureCount).toBe(0);
    expect(metrics.leases.activeCount).toBe(0);
  });

  it('aggregates Remote Fleet operation metrics from records without side effects', () => {
    const readyEnvironment = createEnvironment({ id: 'env-a', lifecycle: { reason: 'ready', readyAt: '2026-07-06T00:00:00.000Z' } });
    const deletingEnvironment = createEnvironment({ id: 'env-b', lifecycle: { reason: 'deleting', commandId: 'command-delete-env' } });
    const readyManagedResource = createManagedResource({ id: 'resource-a', environmentId: 'env-a', lifecycle: { reason: 'ready', observedAt: '2026-07-06T00:00:00.000Z' } });
    const failedManagedResource = createManagedResource({ id: 'resource-b', environmentId: 'env-b', lifecycle: { reason: 'failed', message: 'cleanup failed' } });
    const nodeOnline = createNode({ id: 'node-a', targetKind: 'ssh-host', health: { reason: 'online', lastSeenAt: '2026-07-06T00:00:00.000Z' } });
    const nodeDisabled = createNode({ id: 'node-b', targetKind: 'container', health: { reason: 'disabled', message: 'disabled for maintenance' } });
    const agentEnrolled = createAgent({ id: 'agent-a', nodeId: 'node-a', enrollment: { reason: 'enrolled', enrolledAt: '2026-07-06T00:00:00.000Z' } });
    const agentFailed = createAgent({ id: 'agent-b', nodeId: 'node-b', enrollment: { reason: 'failed', message: 'install failed' } });
    const openclawRuntime = createRuntime({ id: 'runtime-a', nodeId: 'node-a', runtimeKind: 'openclaw', lifecycle: { reason: 'running', startedAt: '2026-07-06T00:00:00.000Z' } });
    const matchaRuntime = createRuntime({ id: 'runtime-b', nodeId: 'node-b', runtimeKind: 'matcha-agent', lifecycle: { reason: 'retired', retiredAt: '2026-07-06T01:00:00.000Z' } });
    const drainingEndpoint = createEndpoint({ id: 'endpoint-b', nodeId: 'node-b', runtimeId: 'runtime-b', health: { reason: 'draining', message: 'draining' } });
    const retiredEndpoint = createEndpoint({ id: 'endpoint-a', nodeId: 'node-a', runtimeId: 'runtime-a', health: { reason: 'retired', retiredAt: '2026-07-06T02:00:00.000Z' } });
    const staleCapability = createCapability({ id: 'cap-a', endpointId: 'endpoint-a', freshness: { reason: 'stale', message: 'probe overdue' } });
    const currentCapability = createCapability({ id: 'cap-b', endpointId: 'endpoint-b', freshness: { reason: 'current', observedAt: '2026-07-06T00:00:00.000Z', descriptorHash: 'hash' } });
    const failedCommand = createCommand({ id: 'command-a', command: 'probe-node', state: { reason: 'failed', completedAt: '2026-07-06T00:01:00.000Z', message: 'probe failed' } });
    const timedOutCommand = createCommand({ id: 'command-b', command: 'start-runtime', state: { reason: 'timed-out', completedAt: '2026-07-06T00:02:00.000Z', timeoutMs: 1000 } });
    const succeededCommand = createCommand({ id: 'command-c', command: 'sync-capabilities', state: { reason: 'succeeded', completedAt: '2026-07-06T00:03:00.000Z' } });
    const activeLease = createLease({ id: 'lease-a', endpointId: 'endpoint-b', state: { reason: 'active', acquiredAt: '2026-07-06T00:00:00.000Z', expiresAt: '2026-07-06T00:30:00.000Z' } });
    const releasedLease = createLease({ id: 'lease-b', endpointId: 'endpoint-a', state: { reason: 'released', releasedAt: '2026-07-06T00:10:00.000Z' } });
    const runtimeStartedAudit = createAuditEvent({ id: 'audit-a', eventName: 'remoteFleet.runtime.started' });
    const runtimeStoppedAudit = createAuditEvent({ id: 'audit-b', eventName: 'remoteFleet.runtime.stopped' });

    const metrics = buildRemoteFleetMetricsSnapshot({
      environments: [readyEnvironment, deletingEnvironment],
      managedResources: [readyManagedResource, failedManagedResource],
      nodes: [nodeOnline, nodeDisabled],
      agents: [agentEnrolled, agentFailed],
      runtimes: [openclawRuntime, matchaRuntime],
      endpoints: [drainingEndpoint, retiredEndpoint],
      capabilities: [staleCapability, currentCapability],
      commands: [failedCommand, timedOutCommand, succeededCommand],
      leases: [activeLease, releasedLease],
      auditEvents: [runtimeStartedAudit, runtimeStoppedAudit],
    });

    expect(metrics.environments.countByStatus).toEqual({ registered: 0, deploying: 0, ready: 1, deleting: 1, deleted: 0, orphaned: 0, failed: 0 });
    expect(metrics.managedResources.countByStatus).toEqual({ observed: 0, provisioning: 0, ready: 1, deleting: 0, deleted: 0, conflict: 0, failed: 1 });
    expect(metrics.nodes.countByStatus).toEqual({ unknown: 0, online: 1, offline: 0, disabled: 1, error: 0 });
    expect(metrics.nodes.countByTargetKind).toEqual({ 'ssh-host': 1, container: 1, vm: 0, 'k8s-pod': 0, custom: 0 });
    expect(metrics.agents.countByStatus).toEqual({ 'not-installed': 0, installing: 0, installed: 0, enrolled: 1, revoked: 0, failed: 1 });
    expect(metrics.runtimes.countByStatus.running).toBe(1);
    expect(metrics.runtimes.countByStatus.retired).toBe(1);
    expect(metrics.runtimes.countByRuntimeKind).toEqual({ openclaw: 1, 'matcha-agent': 1, 'plugin-runtime': 0 });
    expect(metrics.endpoints.countByStatus.draining).toBe(1);
    expect(metrics.endpoints.countByStatus.retired).toBe(1);
    expect(metrics.endpoints.drainingEndpoints).toEqual([{ id: 'endpoint-b', nodeId: 'node-b', runtimeId: 'runtime-b', status: 'draining' }]);
    expect(metrics.endpoints.retiredEndpoints).toEqual([{ id: 'endpoint-a', nodeId: 'node-a', runtimeId: 'runtime-a', status: 'retired' }]);
    expect(metrics.capabilities.countByStatus).toEqual({ unknown: 0, current: 1, stale: 1, pruned: 0 });
    expect(metrics.capabilities.staleCount).toBe(1);
    expect(metrics.commands.countByStatus).toEqual({ queued: 0, running: 0, succeeded: 1, failed: 2, cancelled: 0 });
    expect(metrics.commands.recentFailureCount).toBe(2);
    expect(metrics.leases.countByStatus).toEqual({ active: 1, released: 1, expired: 0 });
    expect(metrics.leases.activeCount).toBe(1);
    expect(metrics.auditEvents.countByEventName['remoteFleet.runtime.started']).toBe(1);
    expect(metrics.auditEvents.countByEventName['remoteFleet.runtime.stopped']).toBe(1);
    expect(metrics.auditEvents.countByEventName['remoteFleet.command.queued']).toBe(0);
  });
});

function createEnvironment(overrides: Partial<RemoteFleetEnvironmentRecord>): RemoteFleetEnvironmentRecord {
  return {
    id: 'environment',
    connectionId: 'connection',
    displayName: 'Environment',
    environmentKind: 'docker-container',
    labels: [],
    enabled: true,
    publicConfig: {},
    secretRefs: {},
    lifecycle: { reason: 'registered' },
    managedResourceIds: [],
    createdAt: '2026-07-06T00:00:00.000Z',
    updatedAt: '2026-07-06T00:00:00.000Z',
    ...overrides,
  };
}

function createManagedResource(overrides: Partial<RemoteFleetManagedResourceRecord>): RemoteFleetManagedResourceRecord {
  return {
    id: 'managed-resource',
    connectionId: 'connection',
    environmentId: 'environment',
    providerKind: 'docker',
    resourceKind: 'docker-container',
    remoteResourceId: 'container-id',
    remoteRefs: [],
    displayName: 'Managed resource',
    labels: [],
    ownership: { reason: 'matcha-managed', evidence: {} },
    cleanupPolicy: { mode: 'delete-on-environment-delete' },
    lifecycle: { reason: 'observed' },
    createdAt: '2026-07-06T00:00:00.000Z',
    updatedAt: '2026-07-06T00:00:00.000Z',
    ...overrides,
  };
}

function createNode(overrides: Partial<RemoteFleetNodeRecord>): RemoteFleetNodeRecord {
  return {
    id: 'node',
    displayName: 'Node',
    targetKind: 'ssh-host',
    labels: [],
    enabled: true,
    publicConfig: {},
    secretRefs: {},
    health: { reason: 'unknown' },
    createdAt: '2026-07-06T00:00:00.000Z',
    updatedAt: '2026-07-06T00:00:00.000Z',
    ...overrides,
  };
}

function createAgent(overrides: Partial<RuntimeAgentRecord>): RuntimeAgentRecord {
  return {
    id: 'agent',
    nodeId: 'node',
    displayName: 'Agent',
    enrollment: { reason: 'not-installed' },
    capabilities: [],
    createdAt: '2026-07-06T00:00:00.000Z',
    updatedAt: '2026-07-06T00:00:00.000Z',
    ...overrides,
  };
}

function createRuntime(overrides: Partial<RuntimeInstanceRecord>): RuntimeInstanceRecord {
  return {
    id: 'runtime',
    nodeId: 'node',
    displayName: 'Runtime',
    runtimeKind: 'openclaw',
    lifecycle: { reason: 'stopped' },
    createdAt: '2026-07-06T00:00:00.000Z',
    updatedAt: '2026-07-06T00:00:00.000Z',
    ...overrides,
  };
}

function createEndpoint(overrides: Partial<RemoteRuntimeEndpointRecord>): RemoteRuntimeEndpointRecord {
  return {
    id: 'endpoint',
    nodeId: 'node',
    runtimeId: 'runtime',
    endpointRef: {
      kind: 'native-runtime',
      runtimeAdapterId: 'remote-fleet',
      runtimeInstanceId: 'runtime',
    },
    scope: {
      kind: 'runtime-instance',
      endpoint: {
        kind: 'native-runtime',
        runtimeAdapterId: 'remote-fleet',
        runtimeInstanceId: 'runtime',
      },
    },
    labels: [],
    health: { reason: 'unknown' },
    createdAt: '2026-07-06T00:00:00.000Z',
    updatedAt: '2026-07-06T00:00:00.000Z',
    ...overrides,
  };
}

function createCapability(overrides: Partial<RemoteCapabilitySnapshotRecord>): RemoteCapabilitySnapshotRecord {
  return {
    id: 'capability',
    endpointId: 'endpoint',
    displayName: 'Capability',
    operationIds: [],
    descriptors: [],
    freshness: { reason: 'unknown' },
    ...overrides,
  };
}

function createCommand(overrides: Partial<RemoteFleetCommandRecord>): RemoteFleetCommandRecord {
  return {
    id: 'command',
    idempotencyKey: 'idempotency-key',
    command: 'command',
    state: { reason: 'queued', queuedAt: '2026-07-06T00:00:00.000Z' },
    createdAt: '2026-07-06T00:00:00.000Z',
    updatedAt: '2026-07-06T00:00:00.000Z',
    ...overrides,
  };
}

function createLease(overrides: Partial<RemoteFleetLeaseRecord>): RemoteFleetLeaseRecord {
  return {
    id: 'lease',
    endpointId: 'endpoint',
    ownerKind: 'runtime-start',
    ownerId: 'owner',
    state: { reason: 'active', acquiredAt: '2026-07-06T00:00:00.000Z', expiresAt: '2026-07-06T00:30:00.000Z' },
    createdAt: '2026-07-06T00:00:00.000Z',
    updatedAt: '2026-07-06T00:00:00.000Z',
    ...overrides,
  };
}

function createAuditEvent(overrides: Partial<RemoteFleetAuditEventRecord>): RemoteFleetAuditEventRecord {
  return {
    id: 'audit',
    eventName: 'remoteFleet.command.completed',
    occurredAt: '2026-07-06T00:00:00.000Z',
    ...overrides,
  };
}
