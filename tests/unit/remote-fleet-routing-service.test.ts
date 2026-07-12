import { describe, expect, it } from 'vitest';
import type { RuntimeEndpointRef, RuntimeScope } from '../../runtime-host/application/agent-runtime/contracts/runtime-address';
import type {
  RemoteCapabilitySnapshotRecord,
  RemoteFleetLeaseRecord,
  RemoteFleetRuntimeKind,
  RemoteRuntimeEndpointRecord,
  RuntimeInstanceRecord,
} from '../../runtime-host/application/remote-fleet/remote-fleet-model';
import { selectRemoteFleetEndpoint } from '../../runtime-host/application/remote-fleet/remote-fleet-routing-service';

const now = '2026-07-06T00:00:00.000Z';
const nowMs = Date.parse(now);

function endpointRef(runtimeId: string): RuntimeEndpointRef {
  return {
    kind: 'native-runtime',
    runtimeAdapterId: 'remote-fleet',
    runtimeInstanceId: runtimeId,
  };
}

function endpointScope(runtimeId: string): RuntimeScope {
  return {
    kind: 'runtime-instance',
    endpoint: endpointRef(runtimeId),
  };
}

function endpoint(input: {
  readonly id: string;
  readonly runtimeId?: string;
  readonly labels?: readonly string[];
  readonly health?: RemoteRuntimeEndpointRecord['health'];
}): RemoteRuntimeEndpointRecord {
  const runtimeId = input.runtimeId ?? `${input.id}:runtime`;
  return {
    id: input.id,
    nodeId: `${input.id}:node`,
    runtimeId,
    endpointRef: endpointRef(runtimeId),
    scope: endpointScope(runtimeId),
    protocol: 'remote-fleet',
    labels: input.labels ?? [],
    health: input.health ?? { reason: 'ready', lastProbeAt: now },
    createdAt: now,
    updatedAt: now,
  };
}

function runtime(input: {
  readonly id: string;
  readonly runtimeKind?: RemoteFleetRuntimeKind;
}): RuntimeInstanceRecord {
  return {
    id: input.id,
    nodeId: `${input.id}:node`,
    displayName: input.id,
    runtimeKind: input.runtimeKind ?? 'openclaw',
    lifecycle: { reason: 'running', startedAt: now },
    createdAt: now,
    updatedAt: now,
  };
}

function capability(input: {
  readonly endpointId: string;
  readonly operationIds?: readonly string[];
  readonly status?: RemoteCapabilitySnapshotRecord['freshness']['reason'];
}): RemoteCapabilitySnapshotRecord {
  const status = input.status ?? 'current';
  return {
    id: `${input.endpointId}:capabilities`,
    endpointId: input.endpointId,
    displayName: 'Remote runtime control',
    operationIds: input.operationIds ?? ['sessions.prompt'],
    descriptors: [],
    freshness: status === 'current'
      ? { reason: 'current', observedAt: now, descriptorHash: `${input.endpointId}:hash` }
      : status === 'stale'
        ? { reason: 'stale', observedAt: now }
        : status === 'pruned'
          ? { reason: 'pruned', prunedAt: now }
          : { reason: 'unknown' },
    observedAt: now,
  };
}

function lease(input: {
  readonly id: string;
  readonly endpointId: string;
  readonly expiresAt?: string;
}): RemoteFleetLeaseRecord {
  return {
    id: input.id,
    endpointId: input.endpointId,
    ownerKind: 'session',
    ownerId: `${input.id}:owner`,
    state: { reason: 'active', acquiredAt: now, expiresAt: input.expiresAt ?? '2026-07-06T00:01:00.000Z' },
    createdAt: now,
    updatedAt: now,
  };
}

describe('selectRemoteFleetEndpoint', () => {
  it('selects a ready endpoint that matches labels, runtime kind, operations, and lease capacity', () => {
    const result = selectRemoteFleetEndpoint({
      endpoints: [endpoint({ id: 'endpoint-a', runtimeId: 'runtime-a', labels: ['gpu', 'linux'] })],
      runtimes: [runtime({ id: 'runtime-a', runtimeKind: 'openclaw' })],
      capabilities: [capability({ endpointId: 'endpoint-a', operationIds: ['sessions.prompt', 'tools.invoke'] })],
      leases: [lease({ id: 'lease-a', endpointId: 'endpoint-a' })],
      requiredLabels: ['linux'],
      requiredRuntimeKind: 'openclaw',
      requiredOperationIds: ['sessions.prompt'],
      maxActiveLeases: 2,
      nowMs,
    });

    expect(result.primary?.endpointId).toBe('endpoint-a');
    expect(result.primary?.activeLeaseCount).toBe(1);
    expect(result.fallbackChain).toEqual([]);
    expect(result.selectionReason).toMatchObject({
      resultType: 'selected',
      primaryEndpointId: 'endpoint-a',
      eligibleEndpointIds: ['endpoint-a'],
      excludedEndpoints: [],
    });
  });

  it('excludes draining endpoints with an explicit reason', () => {
    const result = selectRemoteFleetEndpoint({
      endpoints: [endpoint({ id: 'endpoint-draining', health: { reason: 'draining', message: 'Rolling restart.' } })],
    });

    expect(result.primary).toBeNull();
    expect(result.selectionReason.excludedEndpoints).toEqual([{
      endpoint: expect.objectContaining({ id: 'endpoint-draining' }),
      endpointId: 'endpoint-draining',
      reasons: [{ reason: 'endpoint-draining', message: 'Rolling restart.' }],
    }]);
  });

  it('excludes endpoints when active leases exhaust capacity', () => {
    const result = selectRemoteFleetEndpoint({
      endpoints: [endpoint({ id: 'endpoint-full', health: { reason: 'busy', activeLeaseCount: 2, maxLeaseCount: 2 } })],
      leases: [
        lease({ id: 'lease-a', endpointId: 'endpoint-full' }),
        lease({ id: 'lease-b', endpointId: 'endpoint-full' }),
        lease({ id: 'lease-expired', endpointId: 'endpoint-full', expiresAt: '2026-07-05T23:59:00.000Z' }),
      ],
      nowMs,
    });

    expect(result.primary).toBeNull();
    expect(result.selectionReason.excludedEndpoints[0]?.reasons).toContainEqual({
      reason: 'lease-capacity-exhausted',
      activeLeaseCount: 2,
      maxActiveLeaseCount: 2,
    });
  });

  it('excludes endpoints with missing, stale, or pruned capabilities', () => {
    const result = selectRemoteFleetEndpoint({
      endpoints: [
        endpoint({ id: 'endpoint-missing' }),
        endpoint({ id: 'endpoint-stale' }),
        endpoint({ id: 'endpoint-pruned' }),
      ],
      capabilities: [
        capability({ endpointId: 'endpoint-stale', operationIds: ['sessions.prompt'], status: 'stale' }),
        capability({ endpointId: 'endpoint-pruned', operationIds: ['sessions.prompt'], status: 'pruned' }),
      ],
      requiredOperationIds: ['sessions.prompt'],
    });

    expect(result.primary).toBeNull();
    expect(result.selectionReason.excludedEndpoints.map((excluded) => ({
      endpointId: excluded.endpointId,
      reasons: excluded.reasons,
    }))).toEqual([
      {
        endpointId: 'endpoint-missing',
        reasons: [{ reason: 'capability-snapshot-missing', requiredOperationIds: ['sessions.prompt'] }],
      },
      {
        endpointId: 'endpoint-stale',
        reasons: [{ reason: 'capability-stale', snapshotIds: ['endpoint-stale:capabilities'] }],
      },
      {
        endpointId: 'endpoint-pruned',
        reasons: [{ reason: 'capability-pruned', snapshotIds: ['endpoint-pruned:capabilities'] }],
      },
    ]);
  });

  it('excludes endpoints when current capabilities do not include required operations', () => {
    const result = selectRemoteFleetEndpoint({
      endpoints: [endpoint({ id: 'endpoint-no-tools' })],
      capabilities: [capability({ endpointId: 'endpoint-no-tools', operationIds: ['sessions.prompt'] })],
      requiredOperationIds: ['tools.invoke'],
    });

    expect(result.primary).toBeNull();
    expect(result.selectionReason.excludedEndpoints[0]?.reasons).toEqual([{
      reason: 'capability-missing',
      missingOperationIds: ['tools.invoke'],
    }]);
  });

  it('orders fallback chain after primary by health, active leases, and input order', () => {
    const result = selectRemoteFleetEndpoint({
      endpoints: [
        endpoint({ id: 'endpoint-busy-a', health: { reason: 'busy', activeLeaseCount: 1, maxLeaseCount: 3 } }),
        endpoint({ id: 'endpoint-ready-a' }),
        endpoint({ id: 'endpoint-ready-b' }),
        endpoint({ id: 'endpoint-busy-b', health: { reason: 'busy', activeLeaseCount: 0, maxLeaseCount: 3 } }),
      ],
      maxActiveLeases: {
        'endpoint-busy-a': 3,
        'endpoint-busy-b': 3,
      },
      nowMs,
    });

    expect(result.primary?.endpointId).toBe('endpoint-ready-a');
    expect(result.fallbackChain.map((candidate) => candidate.endpointId)).toEqual([
      'endpoint-ready-b',
      'endpoint-busy-b',
      'endpoint-busy-a',
    ]);
    expect(result.selectionReason.fallbackEndpointIds).toEqual([
      'endpoint-ready-b',
      'endpoint-busy-b',
      'endpoint-busy-a',
    ]);
  });
});
