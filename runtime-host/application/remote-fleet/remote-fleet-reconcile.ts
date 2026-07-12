import type {
  RemoteCapabilitySnapshotRecord,
  RemoteFleetLeaseRecord,
  RemoteRuntimeEndpointRecord,
  RuntimeAgentRecord,
  RuntimeInstanceRecord,
} from './remote-fleet-model';
import type { RemoteFleetPersistedState } from './remote-fleet-store';

export interface RemoteFleetReconcilePlanInput {
  readonly state: RemoteFleetPersistedState;
  readonly now: string;
  readonly capabilityStaleAfterMs: number;
}

export interface RemoteFleetReconcilePlan {
  readonly generatedAt: string;
  readonly restoreDescriptors: readonly RemoteFleetRestoreDescriptorsPlanItem[];
  readonly probeAgents: readonly RemoteFleetProbeAgentPlanItem[];
  readonly reapExpiredLeases: readonly RemoteFleetReapExpiredLeasePlanItem[];
  readonly markStaleCapabilities: readonly RemoteFleetMarkStaleCapabilityPlanItem[];
  readonly pruneRetiredEndpoints: readonly RemoteFleetPruneRetiredEndpointPlanItem[];
  readonly reconcileRunningRuntimes: readonly RemoteFleetReconcileRunningRuntimePlanItem[];
}

export interface RemoteFleetReconcileTargetIds {
  readonly nodeId?: string;
  readonly agentId?: string;
  readonly runtimeId?: string;
  readonly endpointId?: string;
  readonly capabilityId?: string;
  readonly leaseId?: string;
}

export type RemoteFleetRestoreDescriptorsReason = 'persisted-current-descriptors';

export interface RemoteFleetRestoreDescriptorsPlanItem {
  readonly reason: RemoteFleetRestoreDescriptorsReason;
  readonly targetIds: RemoteFleetReconcileTargetIds;
  readonly descriptorCount: number;
}

export type RemoteFleetProbeAgentReason =
  | 'enrolled-agent-needs-post-restore-probe'
  | 'installed-agent-needs-enrollment-probe';

export interface RemoteFleetProbeAgentPlanItem {
  readonly reason: RemoteFleetProbeAgentReason;
  readonly targetIds: RemoteFleetReconcileTargetIds;
}

export interface RemoteFleetReapExpiredLeasePlanItem {
  readonly reason: 'active-lease-expired-before-reconcile';
  readonly targetIds: RemoteFleetReconcileTargetIds;
  readonly expiresAt: string;
}

export type RemoteFleetMarkStaleCapabilityReason =
  | 'capability-observation-expired'
  | 'capability-endpoint-missing'
  | 'capability-endpoint-retired';

export interface RemoteFleetMarkStaleCapabilityPlanItem {
  readonly reason: RemoteFleetMarkStaleCapabilityReason;
  readonly targetIds: RemoteFleetReconcileTargetIds;
  readonly observedAt?: string;
}

export interface RemoteFleetPruneRetiredEndpointPlanItem {
  readonly reason: 'retired-endpoint-scope-must-be-pruned';
  readonly targetIds: RemoteFleetReconcileTargetIds;
}

export type RemoteFleetReconcileRunningRuntimeReason =
  | 'running-runtime-needs-endpoint-probe'
  | 'running-runtime-endpoint-missing'
  | 'running-runtime-endpoint-retired';

export interface RemoteFleetReconcileRunningRuntimePlanItem {
  readonly reason: RemoteFleetReconcileRunningRuntimeReason;
  readonly targetIds: RemoteFleetReconcileTargetIds;
}

export function buildRemoteFleetReconcilePlan(input: RemoteFleetReconcilePlanInput): RemoteFleetReconcilePlan {
  const nowMs = Date.parse(input.now);
  const endpointById = new Map(input.state.endpoints.map((endpoint) => [endpoint.id, endpoint]));

  return {
    generatedAt: input.now,
    restoreDescriptors: input.state.capabilities
      .filter((capability) => shouldRestoreCapabilityDescriptors(capability, endpointById))
      .map((capability) => buildRestoreDescriptorsPlanItem(capability, endpointById.get(capability.endpointId)!))
      .sort(comparePlanItemsByTargets),
    probeAgents: input.state.agents
      .filter(shouldProbeAgent)
      .map(buildProbeAgentPlanItem)
      .sort(comparePlanItemsByTargets),
    reapExpiredLeases: input.state.leases
      .filter((lease) => isExpiredActiveLease(lease, nowMs))
      .map(buildReapExpiredLeasePlanItem)
      .sort(comparePlanItemsByTargets),
    markStaleCapabilities: input.state.capabilities
      .filter((capability) => shouldMarkCapabilityStale(capability, endpointById, nowMs, input.capabilityStaleAfterMs))
      .map((capability) => buildMarkStaleCapabilityPlanItem(capability, endpointById))
      .sort(comparePlanItemsByTargets),
    pruneRetiredEndpoints: input.state.endpoints
      .filter((endpoint) => endpoint.health.reason === 'retired')
      .map(buildPruneRetiredEndpointPlanItem)
      .sort(comparePlanItemsByTargets),
    reconcileRunningRuntimes: input.state.runtimes
      .filter((runtime) => runtime.lifecycle.reason === 'running')
      .map((runtime) => buildReconcileRunningRuntimePlanItem(runtime, endpointById))
      .sort(comparePlanItemsByTargets),
  };
}

function shouldRestoreCapabilityDescriptors(
  capability: RemoteCapabilitySnapshotRecord,
  endpointById: ReadonlyMap<string, RemoteRuntimeEndpointRecord>,
): boolean {
  if (capability.freshness.reason !== 'current' || capability.descriptors.length === 0) {
    return false;
  }
  const endpoint = endpointById.get(capability.endpointId);
  return Boolean(endpoint && endpoint.health.reason !== 'retired');
}

function buildRestoreDescriptorsPlanItem(
  capability: RemoteCapabilitySnapshotRecord,
  endpoint: RemoteRuntimeEndpointRecord,
): RemoteFleetRestoreDescriptorsPlanItem {
  return {
    reason: 'persisted-current-descriptors',
    targetIds: {
      nodeId: capability.nodeId ?? endpoint.nodeId,
      runtimeId: capability.runtimeId ?? endpoint.runtimeId,
      endpointId: capability.endpointId,
      capabilityId: capability.id,
    },
    descriptorCount: capability.descriptors.length,
  };
}

function shouldProbeAgent(agent: RuntimeAgentRecord): boolean {
  return agent.enrollment.reason === 'enrolled' || agent.enrollment.reason === 'installed';
}

function buildProbeAgentPlanItem(agent: RuntimeAgentRecord): RemoteFleetProbeAgentPlanItem {
  return {
    reason: agent.enrollment.reason === 'enrolled'
      ? 'enrolled-agent-needs-post-restore-probe'
      : 'installed-agent-needs-enrollment-probe',
    targetIds: {
      nodeId: agent.nodeId,
      agentId: agent.id,
    },
  };
}

type ActiveRemoteFleetLeaseRecord = RemoteFleetLeaseRecord & {
  readonly state: Extract<RemoteFleetLeaseRecord['state'], { readonly reason: 'active' }>;
};

function isExpiredActiveLease(lease: RemoteFleetLeaseRecord, nowMs: number): lease is ActiveRemoteFleetLeaseRecord {
  return lease.state.reason === 'active' && Date.parse(lease.state.expiresAt) <= nowMs;
}

function buildReapExpiredLeasePlanItem(lease: ActiveRemoteFleetLeaseRecord): RemoteFleetReapExpiredLeasePlanItem {
  return {
    reason: 'active-lease-expired-before-reconcile',
    targetIds: {
      endpointId: lease.endpointId,
      leaseId: lease.id,
    },
    expiresAt: lease.state.expiresAt,
  };
}

function shouldMarkCapabilityStale(
  capability: RemoteCapabilitySnapshotRecord,
  endpointById: ReadonlyMap<string, RemoteRuntimeEndpointRecord>,
  nowMs: number,
  capabilityStaleAfterMs: number,
): boolean {
  if (capability.freshness.reason !== 'current' && capability.freshness.reason !== 'unknown') {
    return false;
  }
  const endpoint = endpointById.get(capability.endpointId);
  if (!endpoint || endpoint.health.reason === 'retired') {
    return true;
  }
  const observedAt = readCapabilityObservedAt(capability);
  return observedAt !== undefined && nowMs - Date.parse(observedAt) >= capabilityStaleAfterMs;
}

function buildMarkStaleCapabilityPlanItem(
  capability: RemoteCapabilitySnapshotRecord,
  endpointById: ReadonlyMap<string, RemoteRuntimeEndpointRecord>,
): RemoteFleetMarkStaleCapabilityPlanItem {
  const endpoint = endpointById.get(capability.endpointId);
  const observedAt = readCapabilityObservedAt(capability);
  return {
    reason: readMarkStaleCapabilityReason(endpoint),
    targetIds: {
      nodeId: capability.nodeId ?? endpoint?.nodeId,
      runtimeId: capability.runtimeId ?? endpoint?.runtimeId,
      endpointId: capability.endpointId,
      capabilityId: capability.id,
    },
    ...(observedAt ? { observedAt } : {}),
  };
}

function readMarkStaleCapabilityReason(
  endpoint: RemoteRuntimeEndpointRecord | undefined,
): RemoteFleetMarkStaleCapabilityReason {
  if (!endpoint) {
    return 'capability-endpoint-missing';
  }
  return endpoint.health.reason === 'retired'
    ? 'capability-endpoint-retired'
    : 'capability-observation-expired';
}

function readCapabilityObservedAt(capability: RemoteCapabilitySnapshotRecord): string | undefined {
  return capability.freshness.reason === 'current'
    ? capability.freshness.observedAt
    : capability.observedAt;
}

function buildPruneRetiredEndpointPlanItem(endpoint: RemoteRuntimeEndpointRecord): RemoteFleetPruneRetiredEndpointPlanItem {
  return {
    reason: 'retired-endpoint-scope-must-be-pruned',
    targetIds: {
      nodeId: endpoint.nodeId,
      runtimeId: endpoint.runtimeId,
      endpointId: endpoint.id,
    },
  };
}

function buildReconcileRunningRuntimePlanItem(
  runtime: RuntimeInstanceRecord,
  endpointById: ReadonlyMap<string, RemoteRuntimeEndpointRecord>,
): RemoteFleetReconcileRunningRuntimePlanItem {
  const endpoint = runtime.endpointId ? endpointById.get(runtime.endpointId) : undefined;
  return {
    reason: readReconcileRunningRuntimeReason(runtime, endpoint),
    targetIds: {
      nodeId: runtime.nodeId,
      ...(runtime.agentId ? { agentId: runtime.agentId } : {}),
      runtimeId: runtime.id,
      ...(runtime.endpointId ? { endpointId: runtime.endpointId } : {}),
    },
  };
}

function readReconcileRunningRuntimeReason(
  runtime: RuntimeInstanceRecord,
  endpoint: RemoteRuntimeEndpointRecord | undefined,
): RemoteFleetReconcileRunningRuntimeReason {
  if (!runtime.endpointId || !endpoint) {
    return 'running-runtime-endpoint-missing';
  }
  if (endpoint.health.reason === 'retired') {
    return 'running-runtime-endpoint-retired';
  }
  return 'running-runtime-needs-endpoint-probe';
}

function comparePlanItemsByTargets(
  left: { readonly targetIds: RemoteFleetReconcileTargetIds },
  right: { readonly targetIds: RemoteFleetReconcileTargetIds },
): number {
  return readTargetSortKey(left.targetIds).localeCompare(readTargetSortKey(right.targetIds));
}

function readTargetSortKey(targetIds: RemoteFleetReconcileTargetIds): string {
  return [
    targetIds.nodeId,
    targetIds.agentId,
    targetIds.runtimeId,
    targetIds.endpointId,
    targetIds.capabilityId,
    targetIds.leaseId,
  ].filter(Boolean).join('|');
}
