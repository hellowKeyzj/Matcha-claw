import { describe, expect, it } from 'vitest';
import type { NativeRuntimeEndpointRef, RuntimeScope } from '../../runtime-host/application/agent-runtime/contracts/runtime-address';
import type { CapabilityDescriptor, CapabilityOperationDescriptor } from '../../runtime-host/application/capabilities/contracts/capability-descriptor';
import {
  selectTeamRunRemoteFleetEndpoint,
  type SelectTeamRunRemoteFleetEndpointRequest,
  type SelectTeamRunRemoteFleetEndpointResult,
  type TeamRunRemoteFleetEndpointView,
} from '../../runtime-host/application/team-runtime/adapters/remote-fleet-team-endpoint-selector-adapter';

const now = '2026-07-06T00:00:00.000Z';
const nowMs = Date.parse(now);

function endpointRef(runtimeInstanceId: string): NativeRuntimeEndpointRef {
  return {
    kind: 'native-runtime',
    runtimeAdapterId: 'remote-fleet',
    runtimeInstanceId,
  };
}

function endpointScope(endpoint: NativeRuntimeEndpointRef): RuntimeScope {
  return {
    kind: 'runtime-instance',
    endpoint,
  };
}

function endpoint(input: {
  readonly id: string;
  readonly endpointRef: NativeRuntimeEndpointRef;
  readonly labels?: readonly string[];
  readonly health?: TeamRunRemoteFleetEndpointView['health'];
}): TeamRunRemoteFleetEndpointView {
  return {
    id: input.id,
    runtimeId: input.endpointRef.runtimeInstanceId,
    endpointRef: input.endpointRef,
    scope: endpointScope(input.endpointRef),
    labels: input.labels ?? [],
    health: input.health ?? { reason: 'ready', lastProbeAt: now },
  };
}

function operation(id: string): CapabilityOperationDescriptor {
  return {
    id,
    title: id,
    targetKind: 'runtime-endpoint',
  };
}

function descriptor(input: {
  readonly id: string;
  readonly endpointRef: NativeRuntimeEndpointRef;
  readonly scope: RuntimeScope;
  readonly operationIds?: readonly string[];
  readonly endpointId?: string;
}): CapabilityDescriptor {
  const operations = (input.operationIds ?? ['team.node.dispatch']).map(operation);
  return {
    id: input.id,
    kind: 'team-endpoint-routing',
    scopeKind: input.scope.kind,
    scope: input.scope,
    targetKinds: ['runtime-endpoint'],
    runtimeAdapterId: input.endpointRef.runtimeAdapterId,
    runtimeInstanceId: input.endpointRef.runtimeInstanceId,
    ...(input.endpointId ? { endpointId: input.endpointId } : {}),
    supportLevel: 'projected',
    availability: 'available',
    operations,
    policyScope: input.id,
    ownerModuleId: 'remote-fleet',
    routeOwnerId: 'remote-fleet',
  };
}

function select(input: SelectTeamRunRemoteFleetEndpointRequest): SelectTeamRunRemoteFleetEndpointResult {
  return selectTeamRunRemoteFleetEndpoint(input);
}

function expectSelected(result: SelectTeamRunRemoteFleetEndpointResult): Extract<SelectTeamRunRemoteFleetEndpointResult, { readonly resultType: 'selected' }> {
  if (result.resultType !== 'selected') {
    throw new Error(`Expected selected endpoint, received ${result.resultType}`);
  }
  return result;
}

function collectObjectKeys(value: unknown): readonly string[] {
  const keys: string[] = [];

  function visit(candidate: unknown): void {
    if (!candidate || typeof candidate !== 'object') return;
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }

    for (const [key, nested] of Object.entries(candidate)) {
      keys.push(key);
      visit(nested);
    }
  }

  visit(value);
  return keys;
}

describe('selectTeamRunRemoteFleetEndpoint', () => {
  it('selects the ready endpoint that satisfies required labels and operations without changing runtime address shape', () => {
    const endpointARef = endpointRef('runtime-a');
    const endpointBRef = endpointRef('runtime-b');
    const endpointA = endpoint({ id: 'endpoint-a', endpointRef: endpointARef, labels: ['linux', 'team-run'] });
    const endpointB = endpoint({ id: 'endpoint-b', endpointRef: endpointBRef, labels: ['gpu', 'linux', 'team-run'] });

    const result = select({
      endpoints: [endpointA, endpointB],
      capabilities: [
        descriptor({ id: 'remote-fleet.endpoint-a.team', endpointRef: endpointARef, scope: endpointA.scope, operationIds: ['team.role.prompt'] }),
        descriptor({ id: 'remote-fleet.endpoint-b.team', endpointRef: endpointBRef, scope: endpointB.scope, operationIds: ['team.node.dispatch', 'team.role.prompt'] }),
      ],
      requiredLabels: ['gpu', 'team-run'],
      requiredOperationIds: ['team.node.dispatch'],
      nowMs,
    });

    const selected = expectSelected(result);
    expect(selected.endpoint).toEqual(endpointB.endpointRef);
    expect(selected.scope).toEqual(endpointB.scope);
    expect(selected.selection.selectionReason.primaryEndpointId).toBe('endpoint-b');
    expect(selected.selection.selectionReason.eligibleEndpointIds).toEqual(['endpoint-b']);
  });

  it('matches capability descriptors by RuntimeScope and excludes endpoints when operations are missing', () => {
    const endpointARef = endpointRef('runtime-a');
    const endpointBRef = endpointRef('runtime-b');
    const endpointA = endpoint({ id: 'endpoint-a', endpointRef: endpointARef, labels: ['team-run'] });
    const endpointB = endpoint({ id: 'endpoint-b', endpointRef: endpointBRef, labels: ['team-run'] });

    const result = select({
      endpoints: [endpointA, endpointB],
      capabilities: [
        descriptor({
          id: 'remote-fleet.endpoint-a.prompt-only',
          endpointRef: endpointARef,
          scope: endpointA.scope,
          operationIds: ['team.role.prompt'],
        }),
        descriptor({
          id: 'remote-fleet.endpoint-b.prompt-only',
          endpointRef: endpointBRef,
          scope: endpointB.scope,
          operationIds: ['team.role.prompt'],
        }),
      ],
      requiredLabels: ['team-run'],
      requiredOperationIds: ['team.node.dispatch'],
      nowMs,
    });

    expect(result.resultType).toBe('no-eligible-endpoint');
    expect(result.selection.selectionReason.excludedEndpoints.map((excluded) => ({
      endpointId: excluded.endpointId,
      reasons: excluded.reasons,
    }))).toEqual([
      {
        endpointId: 'endpoint-a',
        reasons: [{ reason: 'capability-missing', missingOperationIds: ['team.node.dispatch'] }],
      },
      {
        endpointId: 'endpoint-b',
        reasons: [{ reason: 'capability-missing', missingOperationIds: ['team.node.dispatch'] }],
      },
    ]);
  });

  it('surfaces Remote Fleet routing exclusions and ready-before-busy fallback order', () => {
    const drainingRef = endpointRef('runtime-draining');
    const readyARef = endpointRef('runtime-ready-a');
    const readyBRef = endpointRef('runtime-ready-b');
    const busyRef = endpointRef('runtime-busy');
    const endpoints = [
      endpoint({ id: 'endpoint-draining', endpointRef: drainingRef, labels: ['team-run'], health: { reason: 'draining', message: 'Rolling restart.' } }),
      endpoint({ id: 'endpoint-busy', endpointRef: busyRef, labels: ['team-run'], health: { reason: 'busy', activeLeaseCount: 1, maxLeaseCount: 3 } }),
      endpoint({ id: 'endpoint-ready-a', endpointRef: readyARef, labels: ['team-run'] }),
      endpoint({ id: 'endpoint-ready-b', endpointRef: readyBRef, labels: ['team-run'] }),
    ];

    const result = select({
      endpoints,
      capabilities: endpoints.map((candidate) => descriptor({
        id: `remote-fleet.${candidate.id}.team`,
        endpointRef: candidate.endpointRef,
        scope: candidate.scope,
        operationIds: ['team.node.dispatch'],
      })),
      requiredLabels: ['team-run'],
      requiredOperationIds: ['team.node.dispatch'],
      nowMs,
    });

    const selected = expectSelected(result);
    expect(selected.selection.selectionReason.primaryEndpointId).toBe('endpoint-ready-a');
    expect(selected.selection.selectionReason.fallbackEndpointIds).toEqual(['endpoint-ready-b', 'endpoint-busy']);
    expect(selected.selection.selectionReason.excludedEndpoints).toEqual([{
      endpoint: expect.objectContaining({ id: 'endpoint-draining' }),
      endpointId: 'endpoint-draining',
      reasons: [{ reason: 'endpoint-draining', message: 'Rolling restart.' }],
    }]);
  });

  it('returns only TeamRun runtime endpoint facts, not server, container, vm, or node target fields', () => {
    const endpointARef = endpointRef('runtime-a');
    const endpointA = endpoint({ id: 'endpoint-a', endpointRef: endpointARef, labels: ['team-run'] });

    const result = select({
      endpoints: [endpointA],
      capabilities: [descriptor({ id: 'remote-fleet.endpoint-a.team', endpointRef: endpointARef, scope: endpointA.scope })],
      requiredLabels: ['team-run'],
      requiredOperationIds: ['team.node.dispatch'],
      nowMs,
    });

    const selected = expectSelected(result);
    expect(selected.endpoint).toEqual(endpointA.endpointRef);
    expect(selected.scope).toEqual(endpointA.scope);
    expect(collectObjectKeys(selected)).not.toEqual(expect.arrayContaining([
      'server',
      'serverTarget',
      'container',
      'containerTarget',
      'vm',
      'vmTarget',
      'node',
      'nodeId',
      'nodeTarget',
    ]));
  });
});
