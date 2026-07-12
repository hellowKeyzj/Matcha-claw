import type {
  CapabilitySnapshotFreshnessState,
  RemoteCapabilitySnapshotRecord,
  RemoteFleetAuditEventName,
  RemoteFleetAuditEventRecord,
  RemoteFleetCommandRecord,
  RemoteFleetEnvironmentRecord,
  RemoteFleetLeaseRecord,
  RemoteFleetManagedResourceRecord,
  RemoteFleetNodeRecord,
  RemoteFleetRuntimeKind,
  RemoteFleetNodeTargetKind,
  RemoteRuntimeEndpointRecord,
  RuntimeAgentRecord,
  RuntimeInstanceRecord,
} from './remote-fleet-model';

export type RemoteFleetEnvironmentMetricStatus = RemoteFleetEnvironmentRecord['lifecycle']['reason'];
export type RemoteFleetManagedResourceMetricStatus = RemoteFleetManagedResourceRecord['lifecycle']['reason'];
export type RemoteFleetNodeMetricStatus = RemoteFleetNodeRecord['health']['reason'];
export type RuntimeAgentMetricStatus = RuntimeAgentRecord['enrollment']['reason'];
export type RuntimeInstanceMetricStatus = RuntimeInstanceRecord['lifecycle']['reason'];
export type RemoteRuntimeEndpointMetricStatus = RemoteRuntimeEndpointRecord['health']['reason'];
export type RemoteCapabilitySnapshotMetricStatus = CapabilitySnapshotFreshnessState['reason'];
export type RemoteFleetCommandMetricStatus = Exclude<RemoteFleetCommandRecord['state']['reason'], 'timed-out'>;
export type RemoteFleetLeaseMetricStatus = RemoteFleetLeaseRecord['state']['reason'];

export interface RemoteFleetMetricsSnapshotInput {
  readonly environments?: readonly RemoteFleetEnvironmentRecord[];
  readonly managedResources?: readonly RemoteFleetManagedResourceRecord[];
  readonly nodes: readonly RemoteFleetNodeRecord[];
  readonly agents: readonly RuntimeAgentRecord[];
  readonly runtimes: readonly RuntimeInstanceRecord[];
  readonly endpoints: readonly RemoteRuntimeEndpointRecord[];
  readonly capabilities: readonly RemoteCapabilitySnapshotRecord[];
  readonly commands: readonly RemoteFleetCommandRecord[];
  readonly leases: readonly RemoteFleetLeaseRecord[];
  readonly auditEvents: readonly RemoteFleetAuditEventRecord[];
}

export interface RemoteFleetEndpointMetricRef {
  readonly id: string;
  readonly nodeId: string;
  readonly runtimeId: string;
  readonly status: 'draining' | 'retired';
}

export interface RemoteFleetMetricsSnapshot {
  readonly environments: {
    readonly totalCount: number;
    readonly countByStatus: Record<RemoteFleetEnvironmentMetricStatus, number>;
  };
  readonly managedResources: {
    readonly totalCount: number;
    readonly countByStatus: Record<RemoteFleetManagedResourceMetricStatus, number>;
  };
  readonly nodes: {
    readonly totalCount: number;
    readonly countByStatus: Record<RemoteFleetNodeMetricStatus, number>;
    readonly countByTargetKind: Record<RemoteFleetNodeTargetKind, number>;
  };
  readonly agents: {
    readonly totalCount: number;
    readonly countByStatus: Record<RuntimeAgentMetricStatus, number>;
  };
  readonly runtimes: {
    readonly totalCount: number;
    readonly countByStatus: Record<RuntimeInstanceMetricStatus, number>;
    readonly countByRuntimeKind: Record<RemoteFleetRuntimeKind, number>;
  };
  readonly endpoints: {
    readonly totalCount: number;
    readonly countByStatus: Record<RemoteRuntimeEndpointMetricStatus, number>;
    readonly drainingEndpoints: readonly RemoteFleetEndpointMetricRef[];
    readonly retiredEndpoints: readonly RemoteFleetEndpointMetricRef[];
  };
  readonly capabilities: {
    readonly totalCount: number;
    readonly countByStatus: Record<RemoteCapabilitySnapshotMetricStatus, number>;
    readonly staleCount: number;
  };
  readonly commands: {
    readonly totalCount: number;
    readonly countByStatus: Record<RemoteFleetCommandMetricStatus, number>;
    readonly recentFailureCount: number;
  };
  readonly leases: {
    readonly totalCount: number;
    readonly countByStatus: Record<RemoteFleetLeaseMetricStatus, number>;
    readonly activeCount: number;
  };
  readonly auditEvents: {
    readonly totalCount: number;
    readonly countByEventName: Record<RemoteFleetAuditEventName, number>;
  };
}

const REMOTE_FLEET_ENVIRONMENT_METRIC_STATUSES = ['registered', 'deploying', 'ready', 'deleting', 'deleted', 'orphaned', 'failed'] as const satisfies readonly RemoteFleetEnvironmentMetricStatus[];
const REMOTE_FLEET_MANAGED_RESOURCE_METRIC_STATUSES = ['observed', 'provisioning', 'ready', 'deleting', 'deleted', 'conflict', 'failed'] as const satisfies readonly RemoteFleetManagedResourceMetricStatus[];
const REMOTE_FLEET_NODE_METRIC_STATUSES = ['unknown', 'online', 'offline', 'disabled', 'error'] as const satisfies readonly RemoteFleetNodeMetricStatus[];
const REMOTE_FLEET_NODE_TARGET_KINDS = ['ssh-host', 'container', 'vm', 'k8s-pod', 'custom'] as const satisfies readonly RemoteFleetNodeTargetKind[];
const RUNTIME_AGENT_METRIC_STATUSES = ['not-installed', 'installing', 'installed', 'enrolled', 'revoked', 'failed'] as const satisfies readonly RuntimeAgentMetricStatus[];
const REMOTE_FLEET_RUNTIME_KINDS = ['openclaw', 'matcha-agent', 'plugin-runtime'] as const satisfies readonly RemoteFleetRuntimeKind[];
const RUNTIME_INSTANCE_METRIC_STATUSES = ['discovered', 'starting', 'running', 'stopping', 'stopped', 'degraded', 'retired'] as const satisfies readonly RuntimeInstanceMetricStatus[];
const REMOTE_RUNTIME_ENDPOINT_METRIC_STATUSES = ['unknown', 'ready', 'busy', 'draining', 'unhealthy', 'retired'] as const satisfies readonly RemoteRuntimeEndpointMetricStatus[];
const REMOTE_CAPABILITY_SNAPSHOT_METRIC_STATUSES = ['unknown', 'current', 'stale', 'pruned'] as const satisfies readonly RemoteCapabilitySnapshotMetricStatus[];
const REMOTE_FLEET_COMMAND_METRIC_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const satisfies readonly RemoteFleetCommandMetricStatus[];
const REMOTE_FLEET_LEASE_METRIC_STATUSES = ['active', 'released', 'expired'] as const satisfies readonly RemoteFleetLeaseMetricStatus[];
const REMOTE_FLEET_AUDIT_EVENT_NAMES = [
  'remoteFleet.node.registered',
  'remoteFleet.node.removed',
  'remoteFleet.node.probed',
  'remoteFleet.agent.enrollmentIssued',
  'remoteFleet.agent.installQueued',
  'remoteFleet.agent.heartbeatRecorded',
  'remoteFleet.agent.revoked',
  'remoteFleet.runtime.started',
  'remoteFleet.runtime.stopped',
  'remoteFleet.endpoint.drained',
  'remoteFleet.endpoint.retired',
  'remoteFleet.endpoint.capabilitiesSynced',
  'remoteFleet.terminal.opened',
  'remoteFleet.terminal.reconnected',
  'remoteFleet.terminal.closed',
  'remoteFleet.terminal.failed',
  'remoteFleet.command.queued',
  'remoteFleet.command.completed',
] as const satisfies readonly RemoteFleetAuditEventName[];

export function buildRemoteFleetMetricsSnapshot(input: RemoteFleetMetricsSnapshotInput): RemoteFleetMetricsSnapshot {
  const environments = input.environments ?? [];
  const managedResources = input.managedResources ?? [];
  const drainingEndpoints = input.endpoints
    .filter((endpoint) => endpoint.health.reason === 'draining')
    .map((endpoint) => buildEndpointMetricRef(endpoint, 'draining'))
    .sort(compareEndpointMetricRefsById);
  const retiredEndpoints = input.endpoints
    .filter((endpoint) => endpoint.health.reason === 'retired')
    .map((endpoint) => buildEndpointMetricRef(endpoint, 'retired'))
    .sort(compareEndpointMetricRefsById);

  return {
    environments: {
      totalCount: environments.length,
      countByStatus: countByKnownValue(environments, REMOTE_FLEET_ENVIRONMENT_METRIC_STATUSES, (environment) => environment.lifecycle.reason),
    },
    managedResources: {
      totalCount: managedResources.length,
      countByStatus: countByKnownValue(managedResources, REMOTE_FLEET_MANAGED_RESOURCE_METRIC_STATUSES, (managedResource) => managedResource.lifecycle.reason),
    },
    nodes: {
      totalCount: input.nodes.length,
      countByStatus: countByKnownValue(input.nodes, REMOTE_FLEET_NODE_METRIC_STATUSES, (node) => node.health.reason),
      countByTargetKind: countByKnownValue(input.nodes, REMOTE_FLEET_NODE_TARGET_KINDS, (node) => node.targetKind),
    },
    agents: {
      totalCount: input.agents.length,
      countByStatus: countByKnownValue(input.agents, RUNTIME_AGENT_METRIC_STATUSES, (agent) => agent.enrollment.reason),
    },
    runtimes: {
      totalCount: input.runtimes.length,
      countByStatus: countByKnownValue(input.runtimes, RUNTIME_INSTANCE_METRIC_STATUSES, (runtime) => runtime.lifecycle.reason),
      countByRuntimeKind: countByKnownValue(input.runtimes, REMOTE_FLEET_RUNTIME_KINDS, (runtime) => runtime.runtimeKind),
    },
    endpoints: {
      totalCount: input.endpoints.length,
      countByStatus: countByKnownValue(input.endpoints, REMOTE_RUNTIME_ENDPOINT_METRIC_STATUSES, (endpoint) => endpoint.health.reason),
      drainingEndpoints,
      retiredEndpoints,
    },
    capabilities: {
      totalCount: input.capabilities.length,
      countByStatus: countByKnownValue(input.capabilities, REMOTE_CAPABILITY_SNAPSHOT_METRIC_STATUSES, (capability) => capability.freshness.reason),
      staleCount: input.capabilities.filter((capability) => capability.freshness.reason === 'stale').length,
    },
    commands: {
      totalCount: input.commands.length,
      countByStatus: countByKnownValue(input.commands, REMOTE_FLEET_COMMAND_METRIC_STATUSES, readCommandMetricStatus),
      recentFailureCount: input.commands.filter(hasCommandFailed).length,
    },
    leases: {
      totalCount: input.leases.length,
      countByStatus: countByKnownValue(input.leases, REMOTE_FLEET_LEASE_METRIC_STATUSES, (lease) => lease.state.reason),
      activeCount: input.leases.filter((lease) => lease.state.reason === 'active').length,
    },
    auditEvents: {
      totalCount: input.auditEvents.length,
      countByEventName: countByKnownValue(input.auditEvents, REMOTE_FLEET_AUDIT_EVENT_NAMES, (event) => event.eventName),
    },
  };
}

function readCommandMetricStatus(command: RemoteFleetCommandRecord): RemoteFleetCommandMetricStatus {
  return command.state.reason === 'timed-out' ? 'failed' : command.state.reason;
}

function hasCommandFailed(command: RemoteFleetCommandRecord): boolean {
  return command.state.reason === 'failed' || command.state.reason === 'timed-out';
}

function buildEndpointMetricRef(
  endpoint: RemoteRuntimeEndpointRecord,
  status: RemoteFleetEndpointMetricRef['status'],
): RemoteFleetEndpointMetricRef {
  return {
    id: endpoint.id,
    nodeId: endpoint.nodeId,
    runtimeId: endpoint.runtimeId,
    status,
  };
}

function countByKnownValue<TItem, TValue extends string>(
  items: readonly TItem[],
  knownValues: readonly TValue[],
  readValue: (item: TItem) => TValue,
): Record<TValue, number> {
  const counts = Object.fromEntries(knownValues.map((value) => [value, 0])) as Record<TValue, number>;
  for (const item of items) {
    counts[readValue(item)] += 1;
  }
  return counts;
}

function compareEndpointMetricRefsById(left: RemoteFleetEndpointMetricRef, right: RemoteFleetEndpointMetricRef): number {
  return left.id.localeCompare(right.id);
}
