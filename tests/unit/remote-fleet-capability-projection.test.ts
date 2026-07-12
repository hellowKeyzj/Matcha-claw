import { describe, expect, it } from 'vitest';
import type { NativeRuntimeEndpointRef, RuntimeScope } from '../../runtime-host/application/agent-runtime/contracts/runtime-address';
import type { CapabilityDescriptor, CapabilityOperationDescriptor } from '../../runtime-host/application/capabilities/contracts/capability-descriptor';
import type { RemoteCapabilitySnapshotRecord } from '../../runtime-host/application/remote-fleet/remote-fleet-model';
import {
  hashCapabilityDescriptorsStable,
  isCapabilitySnapshotStale,
  markCapabilitySnapshotPruned,
  normalizeCapabilityDescriptorsForEndpoint,
  shouldReplaceCapabilityProjection,
} from '../../runtime-host/application/remote-fleet/remote-fleet-capability-projection';

const endpointRef: NativeRuntimeEndpointRef = {
  kind: 'native-runtime',
  runtimeAdapterId: 'remote-fleet',
  runtimeInstanceId: 'runtime-1',
};

const endpointScope: RuntimeScope = {
  kind: 'runtime-instance',
  endpoint: endpointRef,
};

const endpoint = {
  id: 'runtime-1:endpoint',
  scope: endpointScope,
};

const operations: CapabilityOperationDescriptor[] = [
  { id: 'runtime.stop', title: 'Stop runtime', targetKind: 'runtime-endpoint' },
  { id: 'runtime.start', title: 'Start runtime', targetKind: 'runtime-endpoint', targetRequired: true },
];

function descriptor(input: {
  readonly id: string;
  readonly operations?: readonly CapabilityOperationDescriptor[];
  readonly targetKinds?: readonly CapabilityDescriptor['targetKinds'][number][];
  readonly scope?: RuntimeScope;
}): CapabilityDescriptor {
  const scope = input.scope ?? endpointScope;
  const descriptorOperations = [...(input.operations ?? operations)];
  return {
    id: input.id,
    kind: 'runtime-control',
    scopeKind: scope.kind,
    scope,
    targetKinds: [...(input.targetKinds ?? ['runtime-job', 'runtime-endpoint'])],
    runtimeAdapterId: endpointRef.runtimeAdapterId,
    runtimeInstanceId: endpointRef.runtimeInstanceId,
    targetAgentIds: ['z-agent', 'a-agent'],
    supportLevel: 'projected',
    availability: 'available',
    operations: descriptorOperations,
    policyScope: input.id,
    ownerModuleId: 'remote-fleet',
    routeOwnerId: 'remote-fleet',
  };
}

function snapshot(input: {
  readonly descriptors: readonly CapabilityDescriptor[];
  readonly descriptorHash?: string;
  readonly endpointId?: string;
  readonly freshness?: RemoteCapabilitySnapshotRecord['freshness'];
}): RemoteCapabilitySnapshotRecord {
  const descriptorHash = input.descriptorHash ?? hashCapabilityDescriptorsStable(input.descriptors);
  return {
    id: `${input.endpointId ?? endpoint.id}:capabilities`,
    nodeId: 'node-1',
    runtimeId: 'runtime-1',
    endpointId: input.endpointId ?? endpoint.id,
    displayName: 'Remote runtime control',
    operationIds: input.descriptors.flatMap((candidate) => candidate.operations.map((operation) => operation.id)).sort(),
    descriptors: input.descriptors,
    freshness: input.freshness ?? { reason: 'current', observedAt: '2026-07-06T00:00:00.000Z', descriptorHash },
    observedAt: '2026-07-06T00:00:00.000Z',
  };
}

describe('remote fleet capability projection helpers', () => {
  it('hashes descriptors independently from descriptor, operation, target kind, and agent id order', () => {
    const first = [
      descriptor({ id: 'remote-fleet.runtime-control' }),
      descriptor({ id: 'remote-fleet.session-control' }),
    ];
    const second = [
      descriptor({
        id: 'remote-fleet.session-control',
        operations: [...operations].reverse(),
        targetKinds: ['runtime-endpoint', 'runtime-job'],
      }),
      descriptor({
        id: 'remote-fleet.runtime-control',
        operations: [...operations].reverse(),
        targetKinds: ['runtime-endpoint', 'runtime-job'],
      }),
    ];

    expect(hashCapabilityDescriptorsStable(first)).toBe(hashCapabilityDescriptorsStable(second));
  });

  it('normalizes descriptors for an endpoint with stable ordering', () => {
    const normalized = normalizeCapabilityDescriptorsForEndpoint(endpoint, [
      descriptor({ id: 'remote-fleet.session-control' }),
      descriptor({ id: 'remote-fleet.runtime-control' }),
    ]);

    expect(normalized.map((candidate) => candidate.id)).toEqual([
      'remote-fleet.runtime-control',
      'remote-fleet.session-control',
    ]);
    expect(normalized[0].targetKinds).toEqual(['runtime-endpoint', 'runtime-job']);
    expect(normalized[0].operations.map((operation) => operation.id)).toEqual(['runtime.start', 'runtime.stop']);
    expect(normalized[0].targetAgentIds).toEqual(['a-agent', 'z-agent']);
  });

  it('detects stale snapshots from missing, non-current, or changed descriptor hashes', () => {
    const descriptors = [descriptor({ id: 'remote-fleet.runtime-control' })];
    const descriptorHash = hashCapabilityDescriptorsStable(descriptors);

    expect(isCapabilitySnapshotStale(null, descriptorHash)).toBe(true);
    expect(isCapabilitySnapshotStale(snapshot({ descriptors, descriptorHash }), descriptorHash)).toBe(false);
    expect(isCapabilitySnapshotStale(snapshot({ descriptors, descriptorHash: 'older-hash' }), descriptorHash)).toBe(true);
    expect(isCapabilitySnapshotStale(snapshot({ descriptors, freshness: { reason: 'stale', message: 'Endpoint changed.' } }), descriptorHash)).toBe(true);
  });

  it('marks a snapshot pruned without keeping descriptors registered for restore', () => {
    const descriptors = [descriptor({ id: 'remote-fleet.runtime-control' })];
    const pruned = markCapabilitySnapshotPruned(snapshot({ descriptors }), '2026-07-06T01:00:00.000Z');

    expect(pruned.operationIds).toEqual([]);
    expect(pruned.descriptors).toEqual([]);
    expect(pruned.freshness).toEqual({ reason: 'pruned', prunedAt: '2026-07-06T01:00:00.000Z' });
    expect(pruned.observedAt).toBeUndefined();
  });

  it('rejects descriptors whose scope does not match the endpoint scope', () => {
    const otherScope: RuntimeScope = {
      kind: 'runtime-instance',
      endpoint: {
        ...endpointRef,
        runtimeInstanceId: 'runtime-2',
      },
    };

    expect(() => normalizeCapabilityDescriptorsForEndpoint(endpoint, [
      descriptor({ id: 'remote-fleet.runtime-control', scope: otherScope }),
    ])).toThrow('Capability descriptor scope does not match Remote Fleet endpoint scope');
  });

  it('does not request replacement when endpoint id and stable descriptor hash are unchanged', () => {
    const descriptors = [descriptor({ id: 'remote-fleet.runtime-control' })];
    const currentSnapshot = snapshot({ descriptors });

    expect(shouldReplaceCapabilityProjection({ endpoint, descriptors, snapshot: currentSnapshot })).toBe(false);
    expect(shouldReplaceCapabilityProjection({ endpoint, descriptors, snapshot: snapshot({ descriptors, endpointId: 'other:endpoint' }) })).toBe(true);
  });
});
