import type { RuntimeEndpointRef, RuntimeScope } from '../agent-runtime/contracts/runtime-address';
import type { CapabilityDescriptor } from '../capabilities/contracts/capability-descriptor';
import type { RemoteFleetWritableCredentialName } from './remote-fleet-credential-host-rpc';

export type RemoteFleetNodeTargetKind = 'ssh-host' | 'container' | 'vm' | 'k8s-pod' | 'custom';
export type RemoteFleetRuntimeKind = 'openclaw' | 'matcha-agent' | 'plugin-runtime';
export type RemoteFleetConnectionKind = Extract<RemoteFleetNodeTargetKind, 'ssh-host' | 'container' | 'vm' | 'k8s-pod' | 'custom'>;
export type RemoteFleetEnvironmentKind = 'ssh-workdir' | 'docker-container' | 'k8s-workload' | 'vm-workdir' | 'custom';
export type RemoteFleetManagedResourceProviderKind = 'docker' | 'k8s' | 'ssh' | 'vm' | 'custom';
export type RemoteFleetManagedResourceKind = 'docker-container' | 'k8s-workload' | 'k8s-deployment' | 'k8s-service' | 'k8s-secret' | 'ssh-agent-installation' | 'vm-agent-installation' | 'custom';

export type RemoteFleetNodeHealthState =
  | { reason: 'unknown' }
  | { reason: 'online'; lastSeenAt: string }
  | { reason: 'offline'; lastSeenAt?: string; message?: string }
  | { reason: 'disabled'; message?: string }
  | { reason: 'error'; message: string };

export type RemoteFleetEnvironmentLifecycleState =
  | { reason: 'registered' }
  | { reason: 'deploying'; commandId: string }
  | { reason: 'ready'; readyAt: string }
  | { reason: 'deleting'; commandId: string }
  | { reason: 'deleted'; deletedAt: string }
  | { reason: 'orphaned'; message?: string }
  | { reason: 'failed'; message: string };

export type RemoteFleetManagedResourceOwnership =
  | { reason: 'matcha-managed'; evidence: Record<string, string> }
  | { reason: 'unverified'; message?: string }
  | { reason: 'external'; message?: string };

export type RemoteFleetManagedResourceCleanupPolicy =
  | { mode: 'delete-on-environment-delete' }
  | { mode: 'uninstall-agent-only' }
  | { mode: 'orphan' }
  | { mode: 'none' };

export type RemoteFleetManagedResourceLifecycleState =
  | { reason: 'observed' }
  | { reason: 'provisioning'; commandId: string }
  | { reason: 'ready'; observedAt: string }
  | { reason: 'deleting'; commandId: string }
  | { reason: 'deleted'; deletedAt: string }
  | { reason: 'conflict'; message: string }
  | { reason: 'failed'; message: string };

export type RuntimeAgentEnrollmentState =
  | { reason: 'not-installed' }
  | { reason: 'installing'; commandId: string }
  | { reason: 'installed'; installedAt: string }
  | { reason: 'environment-ready'; readyAt: string }
  | { reason: 'enrolled'; enrolledAt: string; lastHandshakeAt?: string }
  | { reason: 'revoked'; revokedAt: string; message?: string }
  | { reason: 'failed'; message: string };

export type RuntimeInstanceLifecycleState =
  | { reason: 'discovered' }
  | { reason: 'starting'; commandId: string }
  | { reason: 'running'; startedAt: string }
  | { reason: 'stopping'; commandId: string }
  | { reason: 'stopped'; stoppedAt?: string }
  | { reason: 'degraded'; message: string }
  | { reason: 'retired'; retiredAt: string };

export type RemoteRuntimeEndpointHealthState =
  | { reason: 'unknown' }
  | { reason: 'ready'; lastProbeAt: string }
  | { reason: 'busy'; activeLeaseCount: number; maxLeaseCount: number }
  | { reason: 'draining'; message?: string }
  | { reason: 'unhealthy'; message: string; lastProbeAt?: string }
  | { reason: 'retired'; retiredAt: string };

export type CapabilitySnapshotFreshnessState =
  | { reason: 'unknown' }
  | { reason: 'current'; observedAt: string; descriptorHash: string }
  | { reason: 'stale'; observedAt?: string; message?: string }
  | { reason: 'pruned'; prunedAt: string };

export type RemoteFleetCommandState =
  | { reason: 'queued'; queuedAt: string }
  | { reason: 'running'; startedAt: string }
  | { reason: 'succeeded'; completedAt: string }
  | { reason: 'failed'; completedAt: string; message: string }
  | { reason: 'cancelled'; completedAt: string; message?: string }
  | { reason: 'timed-out'; completedAt: string; timeoutMs: number };

export type RemoteFleetLeaseState =
  | { reason: 'active'; acquiredAt: string; expiresAt: string }
  | { reason: 'released'; releasedAt: string }
  | { reason: 'expired'; expiredAt: string };

export type RemoteFleetTerminalSessionState =
  | { reason: 'opening'; openedAt: string }
  | { reason: 'connected'; connectedAt: string }
  | { reason: 'closing'; closingAt: string }
  | { reason: 'closed'; closedAt: string; message?: string }
  | { reason: 'failed'; failedAt: string; message: string }
  | { reason: 'expired'; expiredAt: string; message?: string };

export type RemoteFleetAuditEventName =
  | 'remoteFleet.credential.written'
  | 'remoteFleet.connection.registered'
  | 'remoteFleet.connection.deleted'
  | 'remoteFleet.connection.probed'
  | 'remoteFleet.environment.registered'
  | 'remoteFleet.environment.deployQueued'
  | 'remoteFleet.environment.deployed'
  | 'remoteFleet.environment.deleteQueued'
  | 'remoteFleet.environment.deleted'
  | 'remoteFleet.environment.failed'
  | 'remoteFleet.managedResource.observed'
  | 'remoteFleet.managedResource.provisioned'
  | 'remoteFleet.managedResource.deleteQueued'
  | 'remoteFleet.managedResource.deleted'
  | 'remoteFleet.managedResource.cleanupSkipped'
  | 'remoteFleet.managedResource.failed'
  | 'remoteFleet.node.registered'
  | 'remoteFleet.node.removed'
  | 'remoteFleet.node.probed'
  | 'remoteFleet.agent.enrollmentIssued'
  | 'remoteFleet.agent.installQueued'
  | 'remoteFleet.agent.heartbeatRecorded'
  | 'remoteFleet.agent.revoked'
  | 'remoteFleet.runtime.started'
  | 'remoteFleet.runtime.stopped'
  | 'remoteFleet.endpoint.drained'
  | 'remoteFleet.endpoint.retired'
  | 'remoteFleet.endpoint.capabilitiesSynced'
  | 'remoteFleet.terminal.opened'
  | 'remoteFleet.terminal.reconnected'
  | 'remoteFleet.terminal.closed'
  | 'remoteFleet.terminal.failed'
  | 'remoteFleet.command.queued'
  | 'remoteFleet.command.completed';

export interface RemoteFleetSecretRef {
  readonly kind: 'secret-ref';
  readonly ref: string;
}

export interface RemoteFleetCredentialWriteReceipt {
  readonly operationId: string;
  readonly credentialName: RemoteFleetWritableCredentialName;
  readonly credentialRef: RemoteFleetSecretRef;
  readonly writtenAt: string;
}

export type RemoteFleetCredentialWriteOperationState =
  | { readonly reason: 'pending'; readonly requestedAt: string }
  | {
      readonly reason: 'completed';
      readonly requestedAt: string;
      readonly completedAt: string;
      readonly receipt: RemoteFleetCredentialWriteReceipt;
    };

export interface RemoteFleetCredentialWriteOperationRecord {
  readonly id: string;
  readonly credentialId: string;
  readonly credentialName: string;
  readonly credentialRef: RemoteFleetSecretRef;
  readonly state: RemoteFleetCredentialWriteOperationState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RemoteFleetConnectionRegistrationInput {
  readonly id?: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly connectionKind?: RemoteFleetConnectionKind;
  readonly targetKind?: RemoteFleetNodeTargetKind;
  readonly endpointUrl?: string;
  readonly labels?: readonly string[];
  readonly enabled?: boolean;
  readonly publicConfig?: Record<string, unknown>;
  readonly secretRefs?: Record<string, RemoteFleetSecretRef>;
}

export interface RemoteFleetConnectionRecord {
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
  readonly connectionKind: RemoteFleetConnectionKind;
  readonly endpointUrl?: string;
  readonly labels: readonly string[];
  readonly enabled: boolean;
  readonly publicConfig: Record<string, unknown>;
  readonly secretRefs: Record<string, RemoteFleetSecretRef>;
  readonly health: RemoteFleetNodeHealthState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RemoteFleetEnvironmentRegistrationInput {
  readonly id?: string;
  readonly connectionId: string;
  readonly nodeId?: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly environmentKind?: RemoteFleetEnvironmentKind;
  readonly targetKind?: RemoteFleetNodeTargetKind;
  readonly labels?: readonly string[];
  readonly enabled?: boolean;
  readonly publicConfig?: Record<string, unknown>;
  readonly secretRefs?: Record<string, RemoteFleetSecretRef>;
}

export interface RemoteFleetEnvironmentRecord {
  readonly id: string;
  readonly connectionId: string;
  readonly nodeId?: string;
  readonly displayName: string;
  readonly description?: string;
  readonly environmentKind: RemoteFleetEnvironmentKind;
  readonly labels: readonly string[];
  readonly enabled: boolean;
  readonly publicConfig: Record<string, unknown>;
  readonly secretRefs: Record<string, RemoteFleetSecretRef>;
  readonly lifecycle: RemoteFleetEnvironmentLifecycleState;
  readonly managedResourceIds: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RemoteFleetManagedResourceRef {
  readonly providerKind: RemoteFleetManagedResourceProviderKind;
  readonly resourceKind: string;
  readonly remoteResourceId: string;
  readonly namespace?: string;
  readonly name?: string;
}

export interface RemoteFleetManagedResourceRecord {
  readonly id: string;
  readonly connectionId: string;
  readonly environmentId: string;
  readonly nodeId?: string;
  readonly providerKind: RemoteFleetManagedResourceProviderKind;
  readonly resourceKind: RemoteFleetManagedResourceKind;
  readonly remoteResourceId: string;
  readonly remoteRefs: readonly RemoteFleetManagedResourceRef[];
  readonly displayName: string;
  readonly labels: readonly string[];
  readonly ownership: RemoteFleetManagedResourceOwnership;
  readonly cleanupPolicy: RemoteFleetManagedResourceCleanupPolicy;
  readonly lifecycle: RemoteFleetManagedResourceLifecycleState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastObservedAt?: string;
}

export interface RemoteFleetNodeRegistrationInput {
  readonly connectionId?: string;
  readonly environmentId?: string;
  readonly managedResourceId?: string;
  readonly id?: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly targetKind?: RemoteFleetNodeTargetKind;
  readonly endpointUrl?: string;
  readonly labels?: readonly string[];
  readonly enabled?: boolean;
  readonly publicConfig?: Record<string, unknown>;
  readonly secretRefs?: Record<string, RemoteFleetSecretRef>;
}

export interface RemoteFleetNodeRecord {
  readonly id: string;
  readonly connectionId?: string;
  readonly environmentId?: string;
  readonly managedResourceId?: string;
  readonly displayName: string;
  readonly description?: string;
  readonly targetKind: RemoteFleetNodeTargetKind;
  readonly endpointUrl?: string;
  readonly labels: readonly string[];
  readonly enabled: boolean;
  readonly publicConfig: Record<string, unknown>;
  readonly secretRefs: Record<string, RemoteFleetSecretRef>;
  readonly health: RemoteFleetNodeHealthState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RuntimeAgentRecord {
  readonly id: string;
  readonly connectionId?: string;
  readonly environmentId?: string;
  readonly managedResourceId?: string;
  readonly nodeId: string;
  readonly displayName: string;
  readonly version?: string;
  readonly enrollment: RuntimeAgentEnrollmentState;
  readonly enrollmentTokenHash?: string;
  readonly enrollmentTokenExpiresAt?: string;
  readonly ingressCredentialHash?: string;
  readonly ingressCredentialIssuedAt?: string;
  readonly revokedAt?: string;
  readonly capabilities: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RuntimeInstanceRecord {
  readonly id: string;
  readonly connectionId?: string;
  readonly environmentId?: string;
  readonly managedResourceId?: string;
  readonly nodeId: string;
  readonly agentId?: string;
  readonly displayName: string;
  readonly runtimeKind: RemoteFleetRuntimeKind;
  readonly version?: string;
  readonly endpointId?: string;
  readonly lifecycle: RuntimeInstanceLifecycleState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RemoteRuntimeEndpointRecord {
  readonly id: string;
  readonly connectionId?: string;
  readonly environmentId?: string;
  readonly managedResourceId?: string;
  readonly nodeId: string;
  readonly runtimeId: string;
  readonly endpointRef: RuntimeEndpointRef;
  readonly scope: RuntimeScope;
  readonly url?: string;
  readonly protocol?: string;
  readonly labels: readonly string[];
  readonly health: RemoteRuntimeEndpointHealthState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RemoteCapabilitySnapshotRecord {
  readonly id: string;
  readonly connectionId?: string;
  readonly environmentId?: string;
  readonly managedResourceId?: string;
  readonly nodeId?: string;
  readonly runtimeId?: string;
  readonly endpointId: string;
  readonly displayName: string;
  readonly operationIds: readonly string[];
  readonly descriptors: readonly CapabilityDescriptor[];
  readonly freshness: CapabilitySnapshotFreshnessState;
  readonly observedAt?: string;
}

export interface RemoteFleetCommandRecord {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly connectionId?: string;
  readonly environmentId?: string;
  readonly managedResourceId?: string;
  readonly nodeId?: string;
  readonly agentId?: string;
  readonly runtimeId?: string;
  readonly endpointId?: string;
  readonly command: string;
  readonly state: RemoteFleetCommandState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly message?: string;
}

export interface RemoteFleetLeaseRecord {
  readonly id: string;
  readonly endpointId: string;
  readonly ownerKind: 'manual-operation' | 'runtime-start' | 'session' | 'team-run';
  readonly ownerId: string;
  readonly state: RemoteFleetLeaseState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RemoteFleetTerminalSessionRecord {
  readonly id: string;
  readonly connectionId?: string;
  readonly environmentId?: string;
  readonly managedResourceId?: string;
  readonly nodeId: string;
  readonly runtimeId?: string;
  readonly endpointId?: string;
  readonly targetKind: RemoteFleetNodeTargetKind;
  readonly state: RemoteFleetTerminalSessionState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly leaseId?: string;
}

export interface RemoteFleetAuditEventRecord {
  readonly id: string;
  readonly eventName: RemoteFleetAuditEventName;
  readonly occurredAt: string;
  readonly actorId?: string;
  readonly connectionId?: string;
  readonly environmentId?: string;
  readonly managedResourceId?: string;
  readonly nodeId?: string;
  readonly agentId?: string;
  readonly runtimeId?: string;
  readonly endpointId?: string;
  readonly commandId?: string;
  readonly message?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface RemoteFleetSnapshot {
  readonly connections: readonly RemoteFleetConnectionSummary[];
  readonly environments: readonly RemoteFleetEnvironmentSummary[];
  readonly managedResources: readonly RemoteFleetManagedResourceSummary[];
  readonly nodes: readonly RemoteFleetNodeSummary[];
  readonly agents: readonly RuntimeAgentSummary[];
  readonly runtimes: readonly RuntimeInstanceSummary[];
  readonly endpoints: readonly RemoteRuntimeEndpointSummary[];
  readonly capabilities: readonly RemoteCapabilitySnapshotSummary[];
  readonly commands: readonly RemoteFleetCommandSummary[];
  readonly leases: readonly RemoteFleetLeaseSummary[];
  readonly sessions: readonly RemoteFleetTerminalSessionSummary[];
  readonly auditEvents: readonly RemoteFleetAuditEventSummary[];
  readonly updatedAt: string;
}

export interface RemoteFleetConnectionSummary {
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
  readonly connectionKind: RemoteFleetConnectionKind;
  readonly targetKind: RemoteFleetNodeTargetKind;
  readonly endpointUrl?: string;
  readonly status: string;
  readonly labels: readonly string[];
  readonly enabled: boolean;
  readonly lastSeenAt?: string;
  readonly reason?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface RemoteFleetEnvironmentSummary {
  readonly id: string;
  readonly connectionId: string;
  readonly nodeId?: string;
  readonly displayName: string;
  readonly description?: string;
  readonly environmentKind: RemoteFleetEnvironmentKind;
  readonly targetKind: RemoteFleetNodeTargetKind;
  readonly status: RemoteFleetEnvironmentLifecycleState['reason'];
  readonly labels: readonly string[];
  readonly enabled: boolean;
  readonly managedResourceIds: readonly string[];
  readonly reason?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface RemoteFleetManagedResourceSummary {
  readonly id: string;
  readonly connectionId: string;
  readonly environmentId: string;
  readonly nodeId?: string;
  readonly providerKind: RemoteFleetManagedResourceProviderKind;
  readonly resourceKind: RemoteFleetManagedResourceKind;
  readonly remoteResourceId: string;
  readonly displayName: string;
  readonly status: RemoteFleetManagedResourceLifecycleState['reason'];
  readonly ownership: RemoteFleetManagedResourceOwnership['reason'];
  readonly cleanupPolicy: RemoteFleetManagedResourceCleanupPolicy['mode'];
  readonly labels: readonly string[];
  readonly reason?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly lastObservedAt?: string;
}

export interface RemoteFleetNodeSummary {
  readonly id: string;
  readonly connectionId?: string;
  readonly environmentId?: string;
  readonly managedResourceId?: string;
  readonly displayName: string;
  readonly description?: string;
  readonly targetKind: RemoteFleetNodeTargetKind;
  readonly endpointUrl?: string;
  readonly status: string;
  readonly labels: readonly string[];
  readonly enabled: boolean;
  readonly lastSeenAt?: string;
  readonly reason?: string;
}

export interface RuntimeAgentSummary {
  readonly id: string;
  readonly connectionId?: string;
  readonly environmentId?: string;
  readonly managedResourceId?: string;
  readonly nodeId: string;
  readonly displayName: string;
  readonly status: string;
  readonly capabilities: readonly string[];
}

export interface RuntimeInstanceSummary {
  readonly id: string;
  readonly connectionId?: string;
  readonly environmentId?: string;
  readonly managedResourceId?: string;
  readonly nodeId: string;
  readonly agentId?: string;
  readonly displayName: string;
  readonly status: string;
  readonly endpointId?: string;
  readonly startedAt?: string;
  readonly reason?: string;
}

export interface RemoteRuntimeEndpointSummary {
  readonly id: string;
  readonly connectionId?: string;
  readonly environmentId?: string;
  readonly managedResourceId?: string;
  readonly nodeId: string;
  readonly runtimeId: string;
  readonly url?: string;
  readonly protocol?: string;
  readonly status: string;
  readonly lastProbeAt?: string;
}

export interface RemoteCapabilitySnapshotSummary {
  readonly id: string;
  readonly connectionId?: string;
  readonly environmentId?: string;
  readonly managedResourceId?: string;
  readonly nodeId?: string;
  readonly runtimeId?: string;
  readonly endpointId: string;
  readonly displayName: string;
  readonly operationIds: readonly string[];
  readonly status: string;
}

export interface RemoteFleetCommandSummary {
  readonly id: string;
  readonly connectionId?: string;
  readonly environmentId?: string;
  readonly managedResourceId?: string;
  readonly nodeId?: string;
  readonly runtimeId?: string;
  readonly endpointId?: string;
  readonly command: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly message?: string;
}

export interface RemoteFleetLeaseSummary {
  readonly id: string;
  readonly endpointId: string;
  readonly ownerKind: string;
  readonly ownerId: string;
  readonly status: string;
 readonly expiresAt?: string;
}

export interface RemoteFleetTerminalSessionSummary {
  readonly id: string;
  readonly connectionId?: string;
  readonly environmentId?: string;
  readonly managedResourceId?: string;
  readonly nodeId: string;
  readonly runtimeId?: string;
  readonly endpointId?: string;
  readonly targetKind: RemoteFleetNodeTargetKind;
  readonly status: RemoteFleetTerminalSessionState['reason'];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt?: string;
  readonly reason?: string;
}

export interface RemoteFleetAuditEventSummary {
  readonly id: string;
  readonly eventName: RemoteFleetAuditEventName;
  readonly occurredAt: string;
  readonly connectionId?: string;
  readonly environmentId?: string;
  readonly managedResourceId?: string;
  readonly nodeId?: string;
  readonly agentId?: string;
  readonly runtimeId?: string;
  readonly endpointId?: string;
  readonly commandId?: string;
  readonly message?: string;
}

export interface RemoteFleetWorkerConfig {
  readonly runtimeDataRootDir: string;
  readonly runtimeAgentIngressUrl?: string;
}
