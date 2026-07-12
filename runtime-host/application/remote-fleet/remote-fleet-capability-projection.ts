import {
  buildCapabilityScopeKey,
  type RuntimeScope,
} from '../agent-runtime/contracts/runtime-address';
import type { CapabilityDescriptor, CapabilityOperationDescriptor } from '../capabilities/contracts/capability-descriptor';
import type { RemoteCapabilitySnapshotRecord } from './remote-fleet-model';

export interface RemoteFleetCapabilityProjectionEndpoint {
  readonly id: string;
  readonly scope: RuntimeScope;
}

export interface ShouldReplaceCapabilityProjectionInput {
  readonly endpoint: RemoteFleetCapabilityProjectionEndpoint;
  readonly descriptors: readonly CapabilityDescriptor[];
  readonly snapshot?: RemoteCapabilitySnapshotRecord | null;
  readonly descriptorHash?: string;
}

export function normalizeCapabilityDescriptorsForEndpoint(
  endpoint: RemoteFleetCapabilityProjectionEndpoint,
  descriptors: readonly CapabilityDescriptor[],
): CapabilityDescriptor[] {
  const endpointScopeKey = buildCapabilityScopeKey(endpoint.scope);
  return descriptors
    .map((descriptor) => normalizeCapabilityDescriptorForEndpoint(endpoint, endpointScopeKey, descriptor))
    .sort(compareCapabilityDescriptorsStable);
}

export function hashCapabilityDescriptorsStable(descriptors: readonly CapabilityDescriptor[]): string {
  return `stable-json:${JSON.stringify(canonicalCapabilityDescriptorsForHash(descriptors))}`;
}

export function canonicalCapabilityDescriptorsForHash(descriptors: readonly CapabilityDescriptor[]): Record<string, unknown>[] {
  return descriptors
    .map(canonicalCapabilityDescriptorForHash)
    .sort(compareStableJsonText);
}

export function isCapabilitySnapshotStale(
  snapshot: RemoteCapabilitySnapshotRecord | null | undefined,
  descriptorHash: string,
): boolean {
  if (!snapshot) return true;
  if (snapshot.freshness.reason !== 'current') return true;
  return snapshot.freshness.descriptorHash !== descriptorHash;
}

export function markCapabilitySnapshotPruned(
  snapshot: RemoteCapabilitySnapshotRecord,
  prunedAt: string,
): RemoteCapabilitySnapshotRecord {
  return {
    ...snapshot,
    operationIds: [],
    descriptors: [],
    freshness: { reason: 'pruned', prunedAt },
    observedAt: undefined,
  };
}

export function shouldReplaceCapabilityProjection(input: ShouldReplaceCapabilityProjectionInput): boolean {
  const descriptorHash = input.descriptorHash ?? hashCapabilityDescriptorsStable(input.descriptors);
  if (!input.snapshot) return true;
  if (input.snapshot.endpointId !== input.endpoint.id) return true;
  return isCapabilitySnapshotStale(input.snapshot, descriptorHash);
}

function normalizeCapabilityDescriptorForEndpoint(
  endpoint: RemoteFleetCapabilityProjectionEndpoint,
  endpointScopeKey: string,
  descriptor: CapabilityDescriptor,
): CapabilityDescriptor {
  if (descriptor.scopeKind !== descriptor.scope.kind) {
    throw new Error(`Capability descriptor scopeKind does not match scope kind: ${descriptor.id}`);
  }
  const descriptorScopeKey = buildCapabilityScopeKey(descriptor.scope);
  if (descriptorScopeKey !== endpointScopeKey) {
    throw new Error(`Capability descriptor scope does not match Remote Fleet endpoint scope: endpoint=${endpoint.id} capability=${descriptor.id}`);
  }
  return {
    ...descriptor,
    targetKinds: [...descriptor.targetKinds].sort(compareText),
    operations: descriptor.operations
      .map((operation) => ({ ...operation }))
      .sort(compareCapabilityOperationsStable),
    ...(descriptor.targetAgentIds ? { targetAgentIds: [...descriptor.targetAgentIds].sort(compareText) } : {}),
  };
}

function compareCapabilityDescriptorsStable(left: CapabilityDescriptor, right: CapabilityDescriptor): number {
  return capabilityDescriptorSortKey(left).localeCompare(capabilityDescriptorSortKey(right));
}

function compareCapabilityOperationsStable(
  left: CapabilityOperationDescriptor,
  right: CapabilityOperationDescriptor,
): number {
  return JSON.stringify(canonicalCapabilityOperationForHash(left))
    .localeCompare(JSON.stringify(canonicalCapabilityOperationForHash(right)));
}

function capabilityDescriptorSortKey(descriptor: CapabilityDescriptor): string {
  return JSON.stringify({
    id: descriptor.id,
    kind: descriptor.kind,
    scopeKey: buildCapabilityScopeKey(descriptor.scope),
    operations: descriptor.operations.map((operation) => operation.id),
  });
}

function canonicalCapabilityDescriptorForHash(descriptor: CapabilityDescriptor): Record<string, unknown> {
  if (descriptor.scopeKind !== descriptor.scope.kind) {
    throw new Error(`Capability descriptor scopeKind does not match scope kind: ${descriptor.id}`);
  }
  return {
    id: descriptor.id,
    kind: descriptor.kind,
    scopeKind: descriptor.scopeKind,
    scopeKey: buildCapabilityScopeKey(descriptor.scope),
    targetKinds: [...descriptor.targetKinds].sort(compareText),
    runtimeAdapterId: descriptor.runtimeAdapterId ?? null,
    runtimeInstanceId: descriptor.runtimeInstanceId ?? null,
    protocolId: descriptor.protocolId ?? null,
    connectorId: descriptor.connectorId ?? null,
    endpointId: descriptor.endpointId ?? null,
    targetAgentIds: descriptor.targetAgentIds ? [...descriptor.targetAgentIds].sort(compareText) : [],
    supportLevel: descriptor.supportLevel,
    availability: descriptor.availability,
    operations: descriptor.operations
      .map(canonicalCapabilityOperationForHash)
      .sort(compareStableJsonText),
    policyScope: descriptor.policyScope,
    ownerModuleId: descriptor.ownerModuleId,
    routeOwnerId: descriptor.routeOwnerId,
  };
}

function canonicalCapabilityOperationForHash(operation: CapabilityOperationDescriptor): Record<string, unknown> {
  return {
    id: operation.id,
    title: operation.title,
    targetKind: operation.targetKind,
    targetRequired: operation.targetRequired === true,
  };
}

function compareStableJsonText(left: Record<string, unknown>, right: Record<string, unknown>): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right);
}
