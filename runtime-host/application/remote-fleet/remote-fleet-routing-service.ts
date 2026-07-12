import type {
  RemoteCapabilitySnapshotRecord,
  RemoteCapabilitySnapshotSummary,
  RemoteFleetLeaseRecord,
  RemoteFleetLeaseSummary,
  RemoteFleetRuntimeKind,
  RemoteRuntimeEndpointHealthState,
  RemoteRuntimeEndpointRecord,
  RemoteRuntimeEndpointSummary,
  RuntimeInstanceRecord,
} from './remote-fleet-model';

export type RemoteFleetRoutingEndpointInput = RemoteRuntimeEndpointRecord | RemoteRuntimeEndpointSummary;
export type RemoteFleetRoutingCapabilityInput = RemoteCapabilitySnapshotRecord | RemoteCapabilitySnapshotSummary;
export type RemoteFleetRoutingLeaseInput = RemoteFleetLeaseRecord | RemoteFleetLeaseSummary;
export type RemoteFleetRoutingRuntimeInput = Pick<RuntimeInstanceRecord, 'id' | 'runtimeKind'>;

export interface RemoteFleetEndpointRoutingRequest<TEndpoint extends RemoteFleetRoutingEndpointInput = RemoteFleetRoutingEndpointInput> {
  readonly endpoints: readonly TEndpoint[];
  readonly runtimes?: readonly RemoteFleetRoutingRuntimeInput[];
  readonly capabilities?: readonly RemoteFleetRoutingCapabilityInput[];
  readonly leases?: readonly RemoteFleetRoutingLeaseInput[];
  readonly requiredLabels?: readonly string[];
  readonly requiredRuntimeKind?: RemoteFleetRuntimeKind;
  readonly requiredOperationIds?: readonly string[];
  readonly maxActiveLeases?: number | Readonly<Record<string, number>>;
  readonly nowMs?: number;
}

export interface RemoteFleetEndpointCandidate<TEndpoint extends RemoteFleetRoutingEndpointInput = RemoteFleetRoutingEndpointInput> {
  readonly endpoint: TEndpoint;
  readonly endpointId: string;
  readonly runtimeId: string;
  readonly runtimeKind?: RemoteFleetRuntimeKind;
  readonly activeLeaseCount: number;
  readonly maxActiveLeaseCount?: number;
  readonly matchedOperationIds: readonly string[];
}

export type RemoteFleetEndpointExclusionReason =
  | { readonly reason: 'missing-labels'; readonly missingLabels: readonly string[] }
  | { readonly reason: 'runtime-kind-unavailable'; readonly expectedRuntimeKind: RemoteFleetRuntimeKind }
  | { readonly reason: 'runtime-kind-mismatch'; readonly expectedRuntimeKind: RemoteFleetRuntimeKind; readonly actualRuntimeKind: RemoteFleetRuntimeKind }
  | { readonly reason: 'endpoint-draining'; readonly message?: string }
  | { readonly reason: 'endpoint-retired'; readonly retiredAt?: string }
  | { readonly reason: 'endpoint-health-not-ready'; readonly status: string; readonly message?: string }
  | { readonly reason: 'endpoint-busy'; readonly activeLeaseCount: number }
  | { readonly reason: 'lease-capacity-exhausted'; readonly activeLeaseCount: number; readonly maxActiveLeaseCount: number }
  | { readonly reason: 'capability-snapshot-missing'; readonly requiredOperationIds: readonly string[] }
  | { readonly reason: 'capability-stale'; readonly snapshotIds: readonly string[] }
  | { readonly reason: 'capability-pruned'; readonly snapshotIds: readonly string[] }
  | { readonly reason: 'capability-not-current'; readonly snapshotIds: readonly string[]; readonly statuses: readonly string[] }
  | { readonly reason: 'capability-missing'; readonly missingOperationIds: readonly string[] };

export interface RemoteFleetEndpointExclusion<TEndpoint extends RemoteFleetRoutingEndpointInput = RemoteFleetRoutingEndpointInput> {
  readonly endpoint: TEndpoint;
  readonly endpointId: string;
  readonly reasons: readonly RemoteFleetEndpointExclusionReason[];
}

export interface RemoteFleetEndpointSelectionReason<TEndpoint extends RemoteFleetRoutingEndpointInput = RemoteFleetRoutingEndpointInput> {
  readonly resultType: 'selected' | 'no-eligible-endpoint';
  readonly requiredLabels: readonly string[];
  readonly requiredRuntimeKind?: RemoteFleetRuntimeKind;
  readonly requiredOperationIds: readonly string[];
  readonly evaluatedEndpointIds: readonly string[];
  readonly eligibleEndpointIds: readonly string[];
  readonly primaryEndpointId?: string;
  readonly fallbackEndpointIds: readonly string[];
  readonly excludedEndpoints: readonly RemoteFleetEndpointExclusion<TEndpoint>[];
}

export interface RemoteFleetEndpointRoutingResult<TEndpoint extends RemoteFleetRoutingEndpointInput = RemoteFleetRoutingEndpointInput> {
  readonly primary: RemoteFleetEndpointCandidate<TEndpoint> | null;
  readonly fallbackChain: readonly RemoteFleetEndpointCandidate<TEndpoint>[];
  readonly selectionReason: RemoteFleetEndpointSelectionReason<TEndpoint>;
}

interface EndpointEvaluation<TEndpoint extends RemoteFleetRoutingEndpointInput> extends RemoteFleetEndpointCandidate<TEndpoint> {
  readonly originalIndex: number;
  readonly healthStatus: string;
  readonly exclusionReasons: readonly RemoteFleetEndpointExclusionReason[];
}

type EndpointHealthView =
  | RemoteRuntimeEndpointHealthState
  | { readonly reason: string; readonly lastProbeAt?: string };

export function selectRemoteFleetEndpoint<TEndpoint extends RemoteFleetRoutingEndpointInput>(
  request: RemoteFleetEndpointRoutingRequest<TEndpoint>,
): RemoteFleetEndpointRoutingResult<TEndpoint> {
  const requiredLabels = normalizeStringList(request.requiredLabels ?? []);
  const requiredOperationIds = normalizeStringList(request.requiredOperationIds ?? []);
  const runtimeKindByRuntimeId = buildRuntimeKindByRuntimeId(request.runtimes ?? []);
  const capabilitiesByEndpointId = groupByEndpointId(request.capabilities ?? []);
  const activeLeaseCountByEndpointId = countActiveLeasesByEndpointId(request.leases ?? [], request.nowMs);

  const evaluations = request.endpoints.map((endpoint, originalIndex) => evaluateEndpoint({
    endpoint,
    originalIndex,
    requiredLabels,
    requiredRuntimeKind: request.requiredRuntimeKind,
    requiredOperationIds,
    runtimeKindByRuntimeId,
    capabilitiesByEndpointId,
    activeLeaseCountByEndpointId,
    maxActiveLeases: request.maxActiveLeases,
  }));
  const eligibleCandidates = evaluations
    .filter((evaluation) => evaluation.exclusionReasons.length === 0)
    .sort(compareEndpointEvaluation)
    .map(toEndpointCandidate);
  const primary = eligibleCandidates[0] ?? null;
  const fallbackChain = primary ? eligibleCandidates.slice(1) : [];
  const excludedEndpoints = evaluations
    .filter((evaluation) => evaluation.exclusionReasons.length > 0)
    .map((evaluation) => ({
      endpoint: evaluation.endpoint,
      endpointId: evaluation.endpointId,
      reasons: evaluation.exclusionReasons,
    }));

  return {
    primary,
    fallbackChain,
    selectionReason: {
      resultType: primary ? 'selected' : 'no-eligible-endpoint',
      requiredLabels,
      ...(request.requiredRuntimeKind ? { requiredRuntimeKind: request.requiredRuntimeKind } : {}),
      requiredOperationIds,
      evaluatedEndpointIds: evaluations.map((evaluation) => evaluation.endpointId),
      eligibleEndpointIds: eligibleCandidates.map((candidate) => candidate.endpointId),
      ...(primary ? { primaryEndpointId: primary.endpointId } : {}),
      fallbackEndpointIds: fallbackChain.map((candidate) => candidate.endpointId),
      excludedEndpoints,
    },
  };
}

function evaluateEndpoint<TEndpoint extends RemoteFleetRoutingEndpointInput>(input: {
  readonly endpoint: TEndpoint;
  readonly originalIndex: number;
  readonly requiredLabels: readonly string[];
  readonly requiredRuntimeKind?: RemoteFleetRuntimeKind;
  readonly requiredOperationIds: readonly string[];
  readonly runtimeKindByRuntimeId: ReadonlyMap<string, RemoteFleetRuntimeKind>;
  readonly capabilitiesByEndpointId: ReadonlyMap<string, readonly RemoteFleetRoutingCapabilityInput[]>;
  readonly activeLeaseCountByEndpointId: ReadonlyMap<string, number>;
  readonly maxActiveLeases?: number | Readonly<Record<string, number>>;
}): EndpointEvaluation<TEndpoint> {
  const endpointId = input.endpoint.id;
  const health = readEndpointHealth(input.endpoint);
  const runtimeKind = input.runtimeKindByRuntimeId.get(input.endpoint.runtimeId);
  const activeLeaseCount = resolveActiveLeaseCount(endpointId, health, input.activeLeaseCountByEndpointId);
  const maxActiveLeaseCount = resolveMaxActiveLeaseCount(endpointId, health, input.maxActiveLeases);
  const matchedOperationIds = currentOperationIds(input.capabilitiesByEndpointId.get(endpointId) ?? []);
  const exclusionReasons: RemoteFleetEndpointExclusionReason[] = [
    ...labelExclusionReasons(input.endpoint, input.requiredLabels),
    ...runtimeKindExclusionReasons(input.requiredRuntimeKind, runtimeKind),
    ...healthExclusionReasons(health, activeLeaseCount, maxActiveLeaseCount),
    ...capabilityExclusionReasons(input.requiredOperationIds, input.capabilitiesByEndpointId.get(endpointId) ?? []),
  ];

  return {
    endpoint: input.endpoint,
    endpointId,
    runtimeId: input.endpoint.runtimeId,
    ...(runtimeKind ? { runtimeKind } : {}),
    activeLeaseCount,
    ...(maxActiveLeaseCount !== undefined ? { maxActiveLeaseCount } : {}),
    matchedOperationIds,
    originalIndex: input.originalIndex,
    healthStatus: health.reason,
    exclusionReasons,
  };
}

function labelExclusionReasons(
  endpoint: RemoteFleetRoutingEndpointInput,
  requiredLabels: readonly string[],
): readonly RemoteFleetEndpointExclusionReason[] {
  if (requiredLabels.length === 0) {
    return [];
  }
  const endpointLabels = new Set(normalizeStringList('labels' in endpoint ? endpoint.labels : []));
  const missingLabels = requiredLabels.filter((label) => !endpointLabels.has(label));
  return missingLabels.length > 0
    ? [{ reason: 'missing-labels', missingLabels }]
    : [];
}

function runtimeKindExclusionReasons(
  requiredRuntimeKind: RemoteFleetRuntimeKind | undefined,
  actualRuntimeKind: RemoteFleetRuntimeKind | undefined,
): readonly RemoteFleetEndpointExclusionReason[] {
  if (!requiredRuntimeKind) {
    return [];
  }
  if (!actualRuntimeKind) {
    return [{ reason: 'runtime-kind-unavailable', expectedRuntimeKind: requiredRuntimeKind }];
  }
  return actualRuntimeKind === requiredRuntimeKind
    ? []
    : [{ reason: 'runtime-kind-mismatch', expectedRuntimeKind: requiredRuntimeKind, actualRuntimeKind }];
}

function healthExclusionReasons(
  health: EndpointHealthView,
  activeLeaseCount: number,
  maxActiveLeaseCount: number | undefined,
): readonly RemoteFleetEndpointExclusionReason[] {
  if (health.reason === 'draining') {
    return [{
      reason: 'endpoint-draining',
      ...('message' in health && health.message ? { message: health.message } : {}),
    }];
  }
  if (health.reason === 'retired') {
    return [{
      reason: 'endpoint-retired',
      ...('retiredAt' in health && health.retiredAt ? { retiredAt: health.retiredAt } : {}),
    }];
  }
  if (health.reason !== 'ready' && health.reason !== 'busy') {
    return [{
      reason: 'endpoint-health-not-ready',
      status: health.reason,
      ...('message' in health && health.message ? { message: health.message } : {}),
    }];
  }
  if (maxActiveLeaseCount !== undefined && activeLeaseCount >= maxActiveLeaseCount) {
    return [{ reason: 'lease-capacity-exhausted', activeLeaseCount, maxActiveLeaseCount }];
  }
  return health.reason === 'busy' && maxActiveLeaseCount === undefined
    ? [{ reason: 'endpoint-busy', activeLeaseCount }]
    : [];
}

function capabilityExclusionReasons(
  requiredOperationIds: readonly string[],
  snapshots: readonly RemoteFleetRoutingCapabilityInput[],
): readonly RemoteFleetEndpointExclusionReason[] {
  if (requiredOperationIds.length === 0) {
    return [];
  }
  if (snapshots.length === 0) {
    return [{ reason: 'capability-snapshot-missing', requiredOperationIds }];
  }
  const currentSnapshots = snapshots.filter(isCapabilityCurrent);
  if (currentSnapshots.length === 0) {
    const prunedSnapshotIds = snapshots.filter((snapshot) => readCapabilityStatus(snapshot) === 'pruned').map((snapshot) => snapshot.id);
    if (prunedSnapshotIds.length > 0) {
      return [{ reason: 'capability-pruned', snapshotIds: prunedSnapshotIds }];
    }
    const staleSnapshotIds = snapshots.filter((snapshot) => readCapabilityStatus(snapshot) === 'stale').map((snapshot) => snapshot.id);
    if (staleSnapshotIds.length > 0) {
      return [{ reason: 'capability-stale', snapshotIds: staleSnapshotIds }];
    }
    return [{
      reason: 'capability-not-current',
      snapshotIds: snapshots.map((snapshot) => snapshot.id),
      statuses: Array.from(new Set(snapshots.map(readCapabilityStatus))).sort(),
    }];
  }
  const currentOperations = new Set(currentOperationIds(currentSnapshots));
  const missingOperationIds = requiredOperationIds.filter((operationId) => !currentOperations.has(operationId));
  return missingOperationIds.length > 0
    ? [{ reason: 'capability-missing', missingOperationIds }]
    : [];
}

function compareEndpointEvaluation<TEndpoint extends RemoteFleetRoutingEndpointInput>(
  left: EndpointEvaluation<TEndpoint>,
  right: EndpointEvaluation<TEndpoint>,
): number {
  const healthRank = rankEndpointHealth(left.healthStatus) - rankEndpointHealth(right.healthStatus);
  if (healthRank !== 0) {
    return healthRank;
  }
  const leaseRank = left.activeLeaseCount - right.activeLeaseCount;
  if (leaseRank !== 0) {
    return leaseRank;
  }
  return left.originalIndex - right.originalIndex;
}

function rankEndpointHealth(status: string): number {
  if (status === 'ready') {
    return 0;
  }
  if (status === 'busy') {
    return 1;
  }
  return 2;
}

function toEndpointCandidate<TEndpoint extends RemoteFleetRoutingEndpointInput>(
  evaluation: EndpointEvaluation<TEndpoint>,
): RemoteFleetEndpointCandidate<TEndpoint> {
  return {
    endpoint: evaluation.endpoint,
    endpointId: evaluation.endpointId,
    runtimeId: evaluation.runtimeId,
    ...(evaluation.runtimeKind ? { runtimeKind: evaluation.runtimeKind } : {}),
    activeLeaseCount: evaluation.activeLeaseCount,
    ...(evaluation.maxActiveLeaseCount !== undefined ? { maxActiveLeaseCount: evaluation.maxActiveLeaseCount } : {}),
    matchedOperationIds: evaluation.matchedOperationIds,
  };
}

function buildRuntimeKindByRuntimeId(
  runtimes: readonly RemoteFleetRoutingRuntimeInput[],
): ReadonlyMap<string, RemoteFleetRuntimeKind> {
  const runtimeKindByRuntimeId = new Map<string, RemoteFleetRuntimeKind>();
  for (const runtime of runtimes) {
    runtimeKindByRuntimeId.set(runtime.id, runtime.runtimeKind);
  }
  return runtimeKindByRuntimeId;
}

function groupByEndpointId(
  capabilities: readonly RemoteFleetRoutingCapabilityInput[],
): ReadonlyMap<string, readonly RemoteFleetRoutingCapabilityInput[]> {
  const capabilitiesByEndpointId = new Map<string, RemoteFleetRoutingCapabilityInput[]>();
  for (const capability of capabilities) {
    const snapshots = capabilitiesByEndpointId.get(capability.endpointId) ?? [];
    snapshots.push(capability);
    capabilitiesByEndpointId.set(capability.endpointId, snapshots);
  }
  return capabilitiesByEndpointId;
}

function countActiveLeasesByEndpointId(
  leases: readonly RemoteFleetRoutingLeaseInput[],
  nowMs: number | undefined,
): ReadonlyMap<string, number> {
  const activeLeaseCountByEndpointId = new Map<string, number>();
  for (const lease of leases) {
    if (!isActiveLease(lease, nowMs)) {
      continue;
    }
    activeLeaseCountByEndpointId.set(lease.endpointId, (activeLeaseCountByEndpointId.get(lease.endpointId) ?? 0) + 1);
  }
  return activeLeaseCountByEndpointId;
}

function isActiveLease(lease: RemoteFleetRoutingLeaseInput, nowMs: number | undefined): boolean {
  if ('state' in lease) {
    if (lease.state.reason !== 'active') {
      return false;
    }
    return nowMs === undefined || Date.parse(lease.state.expiresAt) > nowMs;
  }
  if (lease.status !== 'active') {
    return false;
  }
  return nowMs === undefined || !lease.expiresAt || Date.parse(lease.expiresAt) > nowMs;
}

function readEndpointHealth(endpoint: RemoteFleetRoutingEndpointInput): EndpointHealthView {
  if ('health' in endpoint) {
    return endpoint.health;
  }
  return {
    reason: endpoint.status,
    ...(endpoint.lastProbeAt ? { lastProbeAt: endpoint.lastProbeAt } : {}),
  };
}

function resolveActiveLeaseCount(
  endpointId: string,
  health: EndpointHealthView,
  activeLeaseCountByEndpointId: ReadonlyMap<string, number>,
): number {
  const activeLeaseCount = activeLeaseCountByEndpointId.get(endpointId) ?? 0;
  return health.reason === 'busy' && 'activeLeaseCount' in health
    ? Math.max(activeLeaseCount, health.activeLeaseCount)
    : activeLeaseCount;
}

function resolveMaxActiveLeaseCount(
  endpointId: string,
  health: EndpointHealthView,
  maxActiveLeases: number | Readonly<Record<string, number>> | undefined,
): number | undefined {
  const configuredMaxActiveLeases = typeof maxActiveLeases === 'number'
    ? maxActiveLeases
    : maxActiveLeases?.[endpointId];
  if (configuredMaxActiveLeases !== undefined) {
    return Math.max(0, configuredMaxActiveLeases);
  }
  return health.reason === 'busy' && 'maxLeaseCount' in health
    ? Math.max(0, health.maxLeaseCount)
    : undefined;
}

function currentOperationIds(snapshots: readonly RemoteFleetRoutingCapabilityInput[]): readonly string[] {
  return Array.from(new Set(snapshots
    .filter(isCapabilityCurrent)
    .flatMap((snapshot) => snapshot.operationIds)
    .map((operationId) => operationId.trim())
    .filter(Boolean)))
    .sort();
}

function isCapabilityCurrent(snapshot: RemoteFleetRoutingCapabilityInput): boolean {
  return readCapabilityStatus(snapshot) === 'current';
}

function readCapabilityStatus(snapshot: RemoteFleetRoutingCapabilityInput): string {
  return 'freshness' in snapshot ? snapshot.freshness.reason : snapshot.status;
}

function normalizeStringList(values: readonly string[]): readonly string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort();
}
