import { runtimeEndpointsEqual, type RuntimeEndpointRef, type RuntimeScope } from '../../agent-runtime/contracts/runtime-address';
import type { CapabilityDescriptor } from '../../capabilities/contracts/capability-descriptor';
import {
  selectRemoteFleetEndpoint,
  type RemoteFleetEndpointCandidate,
  type RemoteFleetEndpointExclusionReason,
  type RemoteFleetEndpointRoutingRequest,
  type RemoteFleetEndpointRoutingResult,
} from '../../remote-fleet/remote-fleet-routing-service';

export type TeamRunEndpointRuntimeScope = Extract<RuntimeScope, { endpoint: RuntimeEndpointRef }>;
export type TeamRunRemoteFleetRuntimeKind = NonNullable<RemoteFleetEndpointRoutingRequest['requiredRuntimeKind']>;
export type TeamRunRemoteFleetEndpointHealth = Extract<RemoteFleetEndpointRoutingRequest['endpoints'][number], { health: unknown }>['health'];

export type TeamRunRemoteFleetEndpointView = TeamRunRemoteFleetEndpointBase & (
  | {
    readonly health: TeamRunRemoteFleetEndpointHealth;
    readonly status?: string;
    readonly lastProbeAt?: string;
  }
  | {
    readonly status: string;
    readonly lastProbeAt?: string;
    readonly health?: never;
  }
);

export interface TeamRunRemoteFleetEndpointBase {
  readonly id: string;
  readonly runtimeId: string;
  readonly endpointRef: RuntimeEndpointRef;
  readonly scope: TeamRunEndpointRuntimeScope;
  readonly labels: readonly string[];
}

export interface TeamRunRemoteFleetRuntimeRoutingMetadata {
  readonly runtimeId: string;
  readonly runtimeKind: TeamRunRemoteFleetRuntimeKind;
}

export type TeamRunRemoteFleetCapabilityView = CapabilityDescriptor | TeamRunRemoteFleetCapabilitySnapshotView;

export type TeamRunRemoteFleetCapabilitySnapshotView =
  | TeamRunRemoteFleetCapabilitySnapshotByEndpointId
  | TeamRunRemoteFleetCapabilitySnapshotByScope;

export interface TeamRunRemoteFleetCapabilitySnapshotBase {
  readonly id: string;
  readonly displayName?: string;
  readonly operationIds: readonly string[];
  readonly status: string;
}

export interface TeamRunRemoteFleetCapabilitySnapshotByEndpointId extends TeamRunRemoteFleetCapabilitySnapshotBase {
  readonly endpointId: string;
  readonly scope?: TeamRunEndpointRuntimeScope;
}

export interface TeamRunRemoteFleetCapabilitySnapshotByScope extends TeamRunRemoteFleetCapabilitySnapshotBase {
  readonly endpointId?: string;
  readonly scope: TeamRunEndpointRuntimeScope;
}

export type TeamRunRemoteFleetLeaseView = TeamRunRemoteFleetLeaseStatusView | TeamRunRemoteFleetLeaseStateView;

export interface TeamRunRemoteFleetLeaseBase {
  readonly id?: string;
  readonly endpointId: string;
  readonly ownerKind?: string;
  readonly ownerId?: string;
}

export interface TeamRunRemoteFleetLeaseStatusView extends TeamRunRemoteFleetLeaseBase {
  readonly status: string;
  readonly expiresAt?: string;
  readonly state?: never;
}

export interface TeamRunRemoteFleetLeaseStateView extends TeamRunRemoteFleetLeaseBase {
  readonly state: {
    readonly reason: string;
    readonly expiresAt?: string;
  };
  readonly status?: never;
}

export interface SelectTeamRunRemoteFleetEndpointRequest {
  readonly endpoints: readonly TeamRunRemoteFleetEndpointView[];
  readonly capabilities?: readonly TeamRunRemoteFleetCapabilityView[];
  readonly requiredLabels?: readonly string[];
  readonly requiredOperationIds?: readonly string[];
  readonly maxActiveLeases?: number | Readonly<Record<string, number>>;
  readonly leases?: readonly TeamRunRemoteFleetLeaseView[];
  readonly nowMs?: number;
  readonly runtimeRoutingMetadata?: readonly TeamRunRemoteFleetRuntimeRoutingMetadata[];
  readonly requiredRuntimeKind?: TeamRunRemoteFleetRuntimeKind;
}

export type SelectTeamRunRemoteFleetEndpointResult =
  | {
    readonly resultType: 'selected';
    readonly endpoint: RuntimeEndpointRef;
    readonly scope: TeamRunEndpointRuntimeScope;
    readonly selection: TeamRunRemoteFleetEndpointSelection;
  }
  | {
    readonly resultType: 'no-eligible-endpoint';
    readonly selection: TeamRunRemoteFleetEndpointSelection;
  };

export interface TeamRunRemoteFleetEndpointSelection {
  readonly primary: TeamRunRemoteFleetEndpointCandidate | null;
  readonly fallbackChain: readonly TeamRunRemoteFleetEndpointCandidate[];
  readonly selectionReason: TeamRunRemoteFleetEndpointSelectionReason;
}

export interface TeamRunRemoteFleetEndpointCandidate {
  readonly endpoint: TeamRunRemoteFleetEndpointView;
  readonly endpointId: string;
  readonly runtimeId: string;
  readonly runtimeKind?: TeamRunRemoteFleetRuntimeKind;
  readonly activeLeaseCount: number;
  readonly maxActiveLeaseCount?: number;
  readonly matchedOperationIds: readonly string[];
}

export interface TeamRunRemoteFleetEndpointSelectionReason {
  readonly resultType: 'selected' | 'no-eligible-endpoint';
  readonly requiredLabels: readonly string[];
  readonly requiredRuntimeKind?: TeamRunRemoteFleetRuntimeKind;
  readonly requiredOperationIds: readonly string[];
  readonly evaluatedEndpointIds: readonly string[];
  readonly eligibleEndpointIds: readonly string[];
  readonly primaryEndpointId?: string;
  readonly fallbackEndpointIds: readonly string[];
  readonly excludedEndpoints: readonly TeamRunRemoteFleetEndpointExclusion[];
}

export interface TeamRunRemoteFleetEndpointExclusion {
  readonly endpoint: TeamRunRemoteFleetEndpointView;
  readonly endpointId: string;
  readonly reasons: readonly RemoteFleetEndpointExclusionReason[];
}

interface TeamRunRemoteFleetSelectorEndpointBase extends TeamRunRemoteFleetEndpointBase {
  readonly nodeId: string;
  readonly teamRunEndpoint: TeamRunRemoteFleetEndpointView;
}

type TeamRunRemoteFleetSelectorEndpoint = TeamRunRemoteFleetSelectorEndpointBase & (
  | {
    readonly health: TeamRunRemoteFleetEndpointHealth;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly status?: string;
    readonly lastProbeAt?: string;
  }
  | {
    readonly status: string;
    readonly lastProbeAt?: string;
    readonly health?: never;
  }
);

interface TeamRunRemoteFleetSelectorCapabilitySnapshot {
  readonly id: string;
  readonly endpointId: string;
  readonly displayName: string;
  readonly operationIds: readonly string[];
  readonly status: string;
}

interface TeamRunRemoteFleetSelectorLease {
  readonly id: string;
  readonly endpointId: string;
  readonly ownerKind: string;
  readonly ownerId: string;
  readonly status: string;
  readonly expiresAt?: string;
}

export function selectTeamRunRemoteFleetEndpoint(
  request: SelectTeamRunRemoteFleetEndpointRequest,
): SelectTeamRunRemoteFleetEndpointResult {
  const selectorEndpoints = request.endpoints
    .filter(isEndpointScopedToEndpoint)
    .map(toSelectorEndpoint);
  const selection = selectRemoteFleetEndpoint({
    endpoints: selectorEndpoints,
    runtimes: request.runtimeRoutingMetadata?.map(toSelectorRuntimeRoutingMetadata) ?? [],
    capabilities: toSelectorCapabilitySnapshots(selectorEndpoints, request.capabilities ?? []),
    leases: request.leases?.map(toSelectorLease) ?? [],
    requiredLabels: request.requiredLabels,
    requiredRuntimeKind: request.requiredRuntimeKind,
    requiredOperationIds: request.requiredOperationIds,
    maxActiveLeases: request.maxActiveLeases,
    nowMs: request.nowMs,
  } satisfies RemoteFleetEndpointRoutingRequest<TeamRunRemoteFleetSelectorEndpoint>);
  const teamRunSelection = toTeamRunSelection(selection);

  if (!selection.primary) {
    return {
      resultType: 'no-eligible-endpoint',
      selection: teamRunSelection,
    };
  }

  const selectedEndpoint = selection.primary.endpoint.teamRunEndpoint;
  return {
    resultType: 'selected',
    endpoint: selectedEndpoint.endpointRef,
    scope: selectedEndpoint.scope,
    selection: teamRunSelection,
  };
}

function isEndpointScopedToEndpoint(endpoint: TeamRunRemoteFleetEndpointView): boolean {
  return runtimeEndpointsEqual(endpoint.scope.endpoint, endpoint.endpointRef);
}

function toSelectorEndpoint(endpoint: TeamRunRemoteFleetEndpointView): TeamRunRemoteFleetSelectorEndpoint {
  if ('health' in endpoint) {
    return {
      ...endpoint,
      nodeId: endpoint.id,
      teamRunEndpoint: endpoint,
      createdAt: '',
      updatedAt: '',
    };
  }

  return {
    ...endpoint,
    nodeId: endpoint.id,
    teamRunEndpoint: endpoint,
  };
}

function toSelectorRuntimeRoutingMetadata(
  metadata: TeamRunRemoteFleetRuntimeRoutingMetadata,
): NonNullable<RemoteFleetEndpointRoutingRequest['runtimes']>[number] {
  return {
    id: metadata.runtimeId,
    runtimeKind: metadata.runtimeKind,
  };
}

function toSelectorCapabilitySnapshots(
  endpoints: readonly TeamRunRemoteFleetSelectorEndpoint[],
  capabilities: readonly TeamRunRemoteFleetCapabilityView[],
): readonly TeamRunRemoteFleetSelectorCapabilitySnapshot[] {
  const descriptors = capabilities.filter(isCapabilityDescriptor);
  const snapshotViews = capabilities.filter(isCapabilitySnapshotView);

  return [
    ...toDescriptorCapabilitySnapshots(endpoints, descriptors),
    ...snapshotViews.flatMap((snapshot) => toSnapshotViewCapabilitySnapshots(endpoints, snapshot)),
  ];
}

function isCapabilityDescriptor(capability: TeamRunRemoteFleetCapabilityView): capability is CapabilityDescriptor {
  return 'operations' in capability;
}

function isCapabilitySnapshotView(
  capability: TeamRunRemoteFleetCapabilityView,
): capability is TeamRunRemoteFleetCapabilitySnapshotView {
  return 'operationIds' in capability;
}

function toDescriptorCapabilitySnapshots(
  endpoints: readonly TeamRunRemoteFleetSelectorEndpoint[],
  descriptors: readonly CapabilityDescriptor[],
): readonly TeamRunRemoteFleetSelectorCapabilitySnapshot[] {
  return endpoints.flatMap((endpoint) => {
    const endpointDescriptors = descriptors.filter((descriptor) => scopeBelongsToEndpoint(descriptor.scope, endpoint.endpointRef));
    if (endpointDescriptors.length === 0) {
      return [];
    }

    return [{
      id: `${endpoint.id}:team-run-capabilities`,
      endpointId: endpoint.id,
      displayName: `${endpoint.id} capabilities`,
      operationIds: endpointDescriptors.flatMap((descriptor) => descriptor.operations.map((operation) => operation.id)),
      status: 'current',
    }];
  });
}

function toSnapshotViewCapabilitySnapshots(
  endpoints: readonly TeamRunRemoteFleetSelectorEndpoint[],
  snapshot: TeamRunRemoteFleetCapabilitySnapshotView,
): readonly TeamRunRemoteFleetSelectorCapabilitySnapshot[] {
  if (snapshot.endpointId) {
    return [toSelectorCapabilitySnapshot(snapshot, snapshot.endpointId)];
  }

  return endpoints
    .filter((endpoint) => scopeBelongsToEndpoint(snapshot.scope, endpoint.endpointRef))
    .map((endpoint) => toSelectorCapabilitySnapshot(snapshot, endpoint.id));
}

function toSelectorCapabilitySnapshot(
  snapshot: TeamRunRemoteFleetCapabilitySnapshotView,
  endpointId: string,
): TeamRunRemoteFleetSelectorCapabilitySnapshot {
  return {
    id: snapshot.id,
    endpointId,
    displayName: snapshot.displayName ?? snapshot.id,
    operationIds: snapshot.operationIds,
    status: snapshot.status,
  };
}

function scopeBelongsToEndpoint(scope: RuntimeScope, endpointRef: RuntimeEndpointRef): boolean {
  return 'endpoint' in scope && runtimeEndpointsEqual(scope.endpoint, endpointRef);
}

function toSelectorLease(lease: TeamRunRemoteFleetLeaseView, index: number): TeamRunRemoteFleetSelectorLease {
  const expiresAt = 'state' in lease ? lease.state.expiresAt : lease.expiresAt;
  return {
    id: lease.id ?? `team-run-lease:${index}`,
    endpointId: lease.endpointId,
    ownerKind: lease.ownerKind ?? 'team-run',
    ownerId: lease.ownerId ?? '',
    status: 'state' in lease ? lease.state.reason : lease.status,
    ...(expiresAt ? { expiresAt } : {}),
  };
}

function toTeamRunSelection(
  selection: RemoteFleetEndpointRoutingResult<TeamRunRemoteFleetSelectorEndpoint>,
): TeamRunRemoteFleetEndpointSelection {
  return {
    primary: selection.primary ? toTeamRunCandidate(selection.primary) : null,
    fallbackChain: selection.fallbackChain.map(toTeamRunCandidate),
    selectionReason: {
      resultType: selection.selectionReason.resultType,
      requiredLabels: selection.selectionReason.requiredLabels,
      ...(selection.selectionReason.requiredRuntimeKind ? { requiredRuntimeKind: selection.selectionReason.requiredRuntimeKind } : {}),
      requiredOperationIds: selection.selectionReason.requiredOperationIds,
      evaluatedEndpointIds: selection.selectionReason.evaluatedEndpointIds,
      eligibleEndpointIds: selection.selectionReason.eligibleEndpointIds,
      ...(selection.selectionReason.primaryEndpointId ? { primaryEndpointId: selection.selectionReason.primaryEndpointId } : {}),
      fallbackEndpointIds: selection.selectionReason.fallbackEndpointIds,
      excludedEndpoints: selection.selectionReason.excludedEndpoints.map((exclusion) => ({
        endpoint: exclusion.endpoint.teamRunEndpoint,
        endpointId: exclusion.endpointId,
        reasons: exclusion.reasons,
      })),
    },
  };
}

function toTeamRunCandidate(
  candidate: RemoteFleetEndpointCandidate<TeamRunRemoteFleetSelectorEndpoint>,
): TeamRunRemoteFleetEndpointCandidate {
  return {
    endpoint: candidate.endpoint.teamRunEndpoint,
    endpointId: candidate.endpointId,
    runtimeId: candidate.runtimeId,
    ...(candidate.runtimeKind ? { runtimeKind: candidate.runtimeKind } : {}),
    activeLeaseCount: candidate.activeLeaseCount,
    ...(candidate.maxActiveLeaseCount !== undefined ? { maxActiveLeaseCount: candidate.maxActiveLeaseCount } : {}),
    matchedOperationIds: candidate.matchedOperationIds,
  };
}
