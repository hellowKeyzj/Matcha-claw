import { create } from 'zustand';
import { hostApiFetch } from '@/lib/host-api';

const REMOTE_FLEET_BOOTSTRAP_REQUEST_TIMEOUT_MS = 15 * 60_000;

export type RemoteFleetNodeTargetKind = 'ssh-host' | 'container' | 'vm' | 'k8s-pod' | 'custom';
export type RemoteFleetConnectionKind = RemoteFleetNodeTargetKind;
export type RemoteFleetEnvironmentKind = 'ssh-workdir' | 'docker-container' | 'k8s-workload' | 'vm-workdir' | 'custom' | string;
export type RemoteFleetManagedResourceProviderKind = 'docker' | 'k8s' | 'ssh' | 'vm' | 'custom' | string;
export type RemoteFleetManagedResourceKind = 'docker-container' | 'k8s-workload' | 'k8s-deployment' | 'k8s-service' | 'k8s-secret' | 'ssh-agent-installation' | 'vm-agent-installation' | 'custom' | string;
export type RemoteFleetRuntimeStatus = 'running' | 'stopped' | 'starting' | 'stopping' | 'error' | 'unknown' | string;
export type RemoteFleetNodeStatus = 'online' | 'offline' | 'disabled' | 'error' | 'unknown' | string;
export type RemoteFleetCommandStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed-out' | 'unknown' | string;
export type RemoteFleetCommandOutcome = 'succeeded' | 'pending' | 'failed' | 'missing';

export function remoteFleetCommandOutcome(
  command: Pick<RemoteFleetCommandSummary, 'status'> | undefined,
): RemoteFleetCommandOutcome {
  switch (command?.status) {
    case 'succeeded':
      return 'succeeded';
    case 'queued':
    case 'running':
      return 'pending';
    case 'failed':
    case 'cancelled':
    case 'timed-out':
      return 'failed';
    default:
      return 'missing';
  }
}

export interface RemoteFleetSecretRef {
  readonly kind: 'secret-ref';
  readonly ref: string;
}

export interface RemoteFleetConnectionRegistration {
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

export interface RemoteFleetEnvironmentRegistration {
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

export interface RemoteFleetNodeRegistration {
  readonly id?: string;
  readonly connectionId?: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly targetKind?: RemoteFleetNodeTargetKind;
  readonly endpointUrl?: string;
  readonly labels?: readonly string[];
  readonly enabled?: boolean;
  readonly publicConfig?: Record<string, unknown>;
  readonly secretRefs?: Record<string, RemoteFleetSecretRef>;
}

export interface RemoteFleetConnectionSummary {
  readonly id: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly connectionKind?: RemoteFleetConnectionKind;
  readonly targetKind?: RemoteFleetNodeTargetKind;
  readonly endpointUrl?: string;
  readonly status?: RemoteFleetNodeStatus;
  readonly labels?: readonly string[];
  readonly enabled?: boolean;
  readonly lastSeenAt?: string;
  readonly reason?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface RemoteFleetEnvironmentSummary {
  readonly id: string;
  readonly connectionId: string;
  readonly nodeId?: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly environmentKind?: RemoteFleetEnvironmentKind;
  readonly targetKind?: RemoteFleetNodeTargetKind;
  readonly status?: string;
  readonly labels?: readonly string[];
  readonly enabled?: boolean;
  readonly managedResourceIds?: readonly string[];
  readonly reason?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface RemoteFleetManagedResourceSummary {
  readonly id: string;
  readonly connectionId: string;
  readonly environmentId: string;
  readonly nodeId?: string;
  readonly providerKind?: RemoteFleetManagedResourceProviderKind;
  readonly resourceKind?: RemoteFleetManagedResourceKind;
  readonly remoteResourceId?: string;
  readonly displayName?: string;
  readonly status?: string;
  readonly ownership?: string;
  readonly cleanupPolicy?: string;
  readonly labels?: readonly string[];
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
  readonly displayName?: string;
  readonly description?: string;
  readonly targetKind?: RemoteFleetNodeTargetKind;
  readonly endpointUrl?: string;
  readonly status?: RemoteFleetNodeStatus;
  readonly labels?: readonly string[];
  readonly enabled?: boolean;
  readonly lastSeenAt?: string;
  readonly reason?: string;
}

export interface RemoteFleetAgentSummary {
  readonly id: string;
  readonly connectionId?: string;
  readonly environmentId?: string;
  readonly managedResourceId?: string;
  readonly nodeId?: string;
  readonly displayName?: string;
  readonly runtimeId?: string;
  readonly status?: string;
  readonly capabilities?: readonly string[];
  readonly model?: string;
}

export interface RemoteFleetRuntimeSummary {
  readonly id: string;
  readonly connectionId?: string;
  readonly environmentId?: string;
  readonly managedResourceId?: string;
  readonly nodeId?: string;
  readonly agentId?: string;
  readonly displayName?: string;
  readonly status?: RemoteFleetRuntimeStatus;
  readonly endpointId?: string;
  readonly startedAt?: string;
  readonly reason?: string;
}

export interface RemoteFleetEndpointSummary {
  readonly id: string;
  readonly connectionId?: string;
  readonly environmentId?: string;
  readonly managedResourceId?: string;
  readonly nodeId?: string;
  readonly runtimeId?: string;
  readonly url?: string;
  readonly protocol?: string;
  readonly status?: string;
  readonly lastProbeAt?: string;
  readonly labels?: readonly string[];
}

export interface RemoteFleetCapabilitySummary {
  readonly id: string;
  readonly connectionId?: string;
  readonly environmentId?: string;
  readonly managedResourceId?: string;
  readonly nodeId?: string;
  readonly runtimeId?: string;
  readonly endpointId?: string;
  readonly displayName?: string;
  readonly operationIds?: readonly string[];
  readonly status?: string;
}

export interface RemoteFleetCommandSummary {
  readonly id: string;
  readonly connectionId?: string;
  readonly environmentId?: string;
  readonly managedResourceId?: string;
  readonly nodeId?: string;
  readonly agentId?: string;
  readonly runtimeId?: string;
  readonly endpointId?: string;
  readonly command?: string;
  readonly status?: RemoteFleetCommandStatus;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly message?: string;
}

export interface RemoteFleetLeaseSummary {
  readonly id: string;
  readonly endpointId?: string;
  readonly ownerKind?: string;
  readonly ownerId?: string;
  readonly status?: string;
  readonly expiresAt?: string;
}

export type RemoteFleetTerminalSessionStatus = 'opening' | 'connected' | 'closing' | 'closed' | 'failed' | 'expired' | string;

export interface RemoteFleetTerminalSize {
  readonly rows: number;
  readonly cols: number;
}

export interface RemoteFleetTerminalSessionSummary {
  readonly id: string;
  readonly nodeId: string;
  readonly runtimeId?: string;
  readonly endpointId?: string;
  readonly targetKind?: RemoteFleetNodeTargetKind;
  readonly status?: RemoteFleetTerminalSessionStatus;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly expiresAt?: string;
  readonly reason?: string;
}

export interface RemoteFleetTerminalOpenTarget {
  readonly nodeId?: string;
  readonly runtimeId?: string;
  readonly endpointId?: string;
  readonly size?: RemoteFleetTerminalSize;
}

export interface RemoteFleetTerminalConnection {
  readonly sessionId: string;
  readonly ticket: string;
  readonly websocketPath: string;
  readonly expiresAt: string;
}

export interface RemoteFleetTerminalOpenResult {
  readonly session: RemoteFleetTerminalSessionSummary;
  readonly terminalConnection: RemoteFleetTerminalConnection;
}

export interface RemoteFleetAuditEventSummary {
  readonly id: string;
  readonly eventName?: string;
  readonly occurredAt?: string;
  readonly nodeId?: string;
  readonly agentId?: string;
  readonly runtimeId?: string;
  readonly endpointId?: string;
  readonly commandId?: string;
  readonly message?: string;
}

export type RemoteFleetMetricCounts = Record<string, number>;

export interface RemoteFleetEndpointMetricRef {
  readonly id: string;
  readonly nodeId?: string;
  readonly runtimeId?: string;
  readonly status?: 'draining' | 'retired' | string;
}

export interface RemoteFleetMetricsSnapshot {
  readonly nodes: {
    readonly totalCount: number;
    readonly countByStatus: RemoteFleetMetricCounts;
    readonly countByTargetKind: RemoteFleetMetricCounts;
  };
  readonly agents: {
    readonly totalCount: number;
    readonly countByStatus: RemoteFleetMetricCounts;
  };
  readonly runtimes: {
    readonly totalCount: number;
    readonly countByStatus: RemoteFleetMetricCounts;
    readonly countByRuntimeKind: RemoteFleetMetricCounts;
  };
  readonly endpoints: {
    readonly totalCount: number;
    readonly countByStatus: RemoteFleetMetricCounts;
    readonly drainingEndpoints: readonly RemoteFleetEndpointMetricRef[];
    readonly retiredEndpoints: readonly RemoteFleetEndpointMetricRef[];
  };
  readonly capabilities: {
    readonly totalCount: number;
    readonly countByStatus: RemoteFleetMetricCounts;
    readonly staleCount: number;
  };
  readonly commands: {
    readonly totalCount: number;
    readonly countByStatus: RemoteFleetMetricCounts;
    readonly recentFailureCount: number;
  };
  readonly leases: {
    readonly totalCount: number;
    readonly countByStatus: RemoteFleetMetricCounts;
    readonly activeCount: number;
  };
  readonly auditEvents: {
    readonly totalCount: number;
    readonly countByEventName: RemoteFleetMetricCounts;
  };
}

export interface RemoteFleetCredentialWriteInput {
  readonly operationId: string;
  readonly credentialId: string;
  readonly credentialName: string;
  readonly plaintextValue: string;
}

export interface RemoteFleetCredentialWriteResult {
  readonly credentialName: string;
  readonly credentialRef: RemoteFleetSecretRef;
}

export interface RemoteFleetSnapshot {
  readonly connections: readonly RemoteFleetConnectionSummary[];
  readonly environments: readonly RemoteFleetEnvironmentSummary[];
  readonly managedResources: readonly RemoteFleetManagedResourceSummary[];
  readonly nodes: readonly RemoteFleetNodeSummary[];
  readonly agents: readonly RemoteFleetAgentSummary[];
  readonly runtimes: readonly RemoteFleetRuntimeSummary[];
  readonly endpoints: readonly RemoteFleetEndpointSummary[];
  readonly capabilities: readonly RemoteFleetCapabilitySummary[];
  readonly commands: readonly RemoteFleetCommandSummary[];
  readonly leases: readonly RemoteFleetLeaseSummary[];
  readonly sessions: readonly RemoteFleetTerminalSessionSummary[];
  readonly auditEvents: readonly RemoteFleetAuditEventSummary[];
  readonly updatedAt?: string;
}

export type RemoteFleetActionPayload = {
  readonly snapshot?: Partial<RemoteFleetSnapshot> | null;
  readonly connection?: RemoteFleetConnectionSummary;
  readonly environment?: RemoteFleetEnvironmentSummary;
  readonly environments?: readonly RemoteFleetEnvironmentSummary[];
  readonly managedResource?: RemoteFleetManagedResourceSummary;
  readonly managedResources?: readonly RemoteFleetManagedResourceSummary[];
  readonly node?: RemoteFleetNodeSummary;
  readonly agent?: RemoteFleetAgentSummary;
  readonly runtime?: RemoteFleetRuntimeSummary;
  readonly endpoint?: RemoteFleetEndpointSummary;
  readonly capability?: RemoteFleetCapabilitySummary;
  readonly command?: RemoteFleetCommandSummary;
  readonly commands?: readonly RemoteFleetCommandSummary[];
  readonly leases?: readonly RemoteFleetLeaseSummary[];
  readonly sessions?: readonly RemoteFleetTerminalSessionSummary[];
  readonly session?: RemoteFleetTerminalSessionSummary;
  readonly auditEvents?: readonly RemoteFleetAuditEventSummary[];
  readonly success?: boolean;
  readonly message?: string;
};

export type RemoteFleetState = {
  readonly metrics: RemoteFleetMetricsSnapshot | null;
  readonly connections: readonly RemoteFleetConnectionSummary[];
  readonly environments: readonly RemoteFleetEnvironmentSummary[];
  readonly managedResources: readonly RemoteFleetManagedResourceSummary[];
  readonly nodes: readonly RemoteFleetNodeSummary[];
  readonly agents: readonly RemoteFleetAgentSummary[];
  readonly runtimes: readonly RemoteFleetRuntimeSummary[];
  readonly endpoints: readonly RemoteFleetEndpointSummary[];
  readonly capabilities: readonly RemoteFleetCapabilitySummary[];
  readonly commands: readonly RemoteFleetCommandSummary[];
  readonly leases: readonly RemoteFleetLeaseSummary[];
  readonly sessions: readonly RemoteFleetTerminalSessionSummary[];
  readonly auditEvents: readonly RemoteFleetAuditEventSummary[];
  readonly ready: boolean;
  readonly loading: boolean;
  readonly mutatingAction: string | null;
  readonly error: string | null;
  readonly refresh: () => Promise<void>;
  readonly loadMetrics: () => Promise<RemoteFleetMetricsSnapshot>;
  readonly registerConnection: (connection: RemoteFleetConnectionRegistration) => Promise<RemoteFleetActionPayload>;
  readonly probeConnection: (connectionId: string) => Promise<RemoteFleetActionPayload>;
  readonly deleteConnection: (connectionId: string) => Promise<RemoteFleetActionPayload>;
  readonly registerEnvironment: (environment: RemoteFleetEnvironmentRegistration) => Promise<RemoteFleetActionPayload>;
  readonly deployEnvironment: (environmentId: string) => Promise<RemoteFleetActionPayload>;
  readonly deleteEnvironment: (environmentId: string) => Promise<RemoteFleetActionPayload>;
  readonly register: (node: RemoteFleetNodeRegistration) => Promise<RemoteFleetActionPayload>;
  readonly probe: (nodeId: string) => Promise<RemoteFleetActionPayload>;
  readonly install: (nodeId: string) => Promise<RemoteFleetActionPayload>;
  readonly start: (runtime: RemoteFleetRuntimeSummary) => Promise<RemoteFleetActionPayload>;
  readonly stop: (runtime: RemoteFleetRuntimeSummary) => Promise<RemoteFleetActionPayload>;
  readonly sync: (endpoint: RemoteFleetEndpointSummary) => Promise<RemoteFleetActionPayload>;
  readonly drain: (endpointId: string) => Promise<RemoteFleetActionPayload>;
  readonly retire: (endpointId: string) => Promise<RemoteFleetActionPayload>;
  readonly revoke: (agentId: string) => Promise<RemoteFleetActionPayload>;
  readonly writeCredential: (input: RemoteFleetCredentialWriteInput) => Promise<RemoteFleetCredentialWriteResult>;
  readonly remove: (nodeId: string) => Promise<RemoteFleetActionPayload>;
  readonly openTerminal: (target: RemoteFleetTerminalOpenTarget) => Promise<RemoteFleetTerminalOpenResult>;
  readonly reconnectTerminal: (sessionId: string) => Promise<RemoteFleetTerminalOpenResult>;
  readonly closeTerminal: (sessionId: string, reason?: string) => Promise<RemoteFleetActionPayload>;
  readonly listTerminalSessions: () => Promise<readonly RemoteFleetTerminalSessionSummary[]>;
  readonly listCommands: () => Promise<readonly RemoteFleetCommandSummary[]>;
  readonly listAuditEvents: () => Promise<readonly RemoteFleetAuditEventSummary[]>;
  readonly clearError: () => void;
};

type RemoteFleetProjectionState = Pick<
  RemoteFleetState,
  'connections' | 'environments' | 'managedResources' | 'nodes' | 'agents' | 'runtimes' | 'endpoints' | 'capabilities' | 'commands' | 'leases' | 'sessions' | 'auditEvents'
>;

type RemoteFleetProjectionPatch = Partial<RemoteFleetProjectionState>;

const EMPTY_REMOTE_FLEET_SNAPSHOT: RemoteFleetSnapshot = {
  connections: [],
  environments: [],
  managedResources: [],
  nodes: [],
  agents: [],
  runtimes: [],
  endpoints: [],
  capabilities: [],
  commands: [],
  leases: [],
  sessions: [],
  auditEvents: [],
};

const EMPTY_REMOTE_FLEET_METRICS: RemoteFleetMetricsSnapshot = {
  nodes: { totalCount: 0, countByStatus: {}, countByTargetKind: {} },
  agents: { totalCount: 0, countByStatus: {} },
  runtimes: { totalCount: 0, countByStatus: {}, countByRuntimeKind: {} },
  endpoints: { totalCount: 0, countByStatus: {}, drainingEndpoints: [], retiredEndpoints: [] },
  capabilities: { totalCount: 0, countByStatus: {}, staleCount: 0 },
  commands: { totalCount: 0, countByStatus: {}, recentFailureCount: 0 },
  leases: { totalCount: 0, countByStatus: {}, activeCount: 0 },
  auditEvents: { totalCount: 0, countByEventName: {} },
};

async function remoteFleetPost<TResult>(
  path: string,
  body: Record<string, unknown>,
  options: { readonly timeoutMs?: number } = {},
): Promise<TResult> {
  return await hostApiFetch<TResult>(path, {
    method: 'POST',
    body: JSON.stringify(body),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  });
}

const REMOTE_FLEET_SECRET_LIKE_PROJECTION_FIELD_PATTERN = /(?:secret|token|ticket|password|authorization|credential|apiKey|accessKey|secretKey|idempotencyKey|stdout|stderr|logs?)/i;

function compactProjection<T extends Record<string, unknown>>(projection: T): T {
  return Object.fromEntries(Object.entries(projection).filter(([, value]) => value !== undefined)) as T;
}

function compactRemoteFleetSummary<T extends Record<string, unknown>>(projection: T): T {
  return Object.fromEntries(
    Object.entries(projection).filter(([key, value]) => value !== undefined && !REMOTE_FLEET_SECRET_LIKE_PROJECTION_FIELD_PATTERN.test(key)),
  ) as T;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readStringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined;
}

function readNodeTargetKind(value: unknown): RemoteFleetNodeTargetKind | undefined {
  return value === 'ssh-host' || value === 'container' || value === 'vm' || value === 'k8s-pod' || value === 'custom'
    ? value
    : undefined;
}

function normalizeTerminalSize(value: unknown): RemoteFleetTerminalSize | undefined {
  const record = readRecord(value);
  const rows = readNumber(record.rows);
  const cols = readNumber(record.cols);
  if (!rows || !cols) return undefined;
  return { rows, cols };
}

function compactTerminalOpenTarget(target: RemoteFleetTerminalOpenTarget): Record<string, unknown> {
  return compactProjection({
    nodeId: target.nodeId,
    runtimeId: target.runtimeId,
    endpointId: target.endpointId,
    size: target.size ? normalizeTerminalSize(target.size) : undefined,
  });
}

function normalizeMetricCounts(value: unknown): RemoteFleetMetricCounts {
  return Object.fromEntries(
    Object.entries(readRecord(value)).filter(([, count]) => typeof count === 'number' && Number.isFinite(count)),
  ) as RemoteFleetMetricCounts;
}

function createRemoteFleetRuntimeEndpoint(runtime: RemoteFleetRuntimeSummary) {
  if (!runtime.id) {
    throw new Error('Remote Fleet runtime id is required');
  }
  return {
    kind: 'native-runtime' as const,
    runtimeAdapterId: 'remote-fleet',
    runtimeInstanceId: runtime.id,
  };
}

function createRemoteFleetCapabilityExecutePayload(
  operationId: 'remoteFleet.runtime.start' | 'remoteFleet.runtime.stop' | 'remoteFleet.capabilities.sync',
  runtime: RemoteFleetRuntimeSummary,
): Record<string, unknown> {
  const endpoint = createRemoteFleetRuntimeEndpoint(runtime);
  return {
    id: 'remote-fleet.runtime-control',
    operationId,
    scope: { kind: 'runtime-instance', endpoint },
    target: { kind: 'runtime-endpoint' },
    input: {},
  };
}

function runtimeForEndpoint(endpoint: RemoteFleetEndpointSummary): RemoteFleetRuntimeSummary {
  if (!endpoint.runtimeId) {
    throw new Error('Remote Fleet endpoint runtimeId is required');
  }
  return {
    id: endpoint.runtimeId,
    nodeId: endpoint.nodeId,
    endpointId: endpoint.id,
  };
}

function normalizeConnectionSummary(value: unknown): RemoteFleetConnectionSummary | null {
  const record = readRecord(value);
  const id = readString(record.id);
  if (!id) return null;
  return compactRemoteFleetSummary({
    id,
    displayName: readString(record.displayName),
    description: readString(record.description),
    connectionKind: readNodeTargetKind(record.connectionKind ?? record.targetKind),
    targetKind: readNodeTargetKind(record.targetKind ?? record.connectionKind),
    endpointUrl: readString(record.endpointUrl),
    status: readString(record.status),
    labels: readStringArray(record.labels),
    enabled: readBoolean(record.enabled),
    lastSeenAt: readString(record.lastSeenAt),
    reason: readString(record.reason),
    createdAt: readString(record.createdAt),
    updatedAt: readString(record.updatedAt),
  });
}

function normalizeEnvironmentSummary(value: unknown): RemoteFleetEnvironmentSummary | null {
  const record = readRecord(value);
  const id = readString(record.id);
  const connectionId = readString(record.connectionId);
  if (!id || !connectionId) return null;
  return compactRemoteFleetSummary({
    id,
    connectionId,
    nodeId: readString(record.nodeId),
    displayName: readString(record.displayName),
    description: readString(record.description),
    environmentKind: readString(record.environmentKind),
    targetKind: readNodeTargetKind(record.targetKind),
    status: readString(record.status),
    labels: readStringArray(record.labels),
    enabled: readBoolean(record.enabled),
    managedResourceIds: readStringArray(record.managedResourceIds),
    reason: readString(record.reason),
    createdAt: readString(record.createdAt),
    updatedAt: readString(record.updatedAt),
  });
}

function normalizeManagedResourceSummary(value: unknown): RemoteFleetManagedResourceSummary | null {
  const record = readRecord(value);
  const id = readString(record.id);
  const connectionId = readString(record.connectionId);
  const environmentId = readString(record.environmentId);
  if (!id || !connectionId || !environmentId) return null;
  return compactRemoteFleetSummary({
    id,
    connectionId,
    environmentId,
    nodeId: readString(record.nodeId),
    providerKind: readString(record.providerKind),
    resourceKind: readString(record.resourceKind),
    remoteResourceId: readString(record.remoteResourceId),
    displayName: readString(record.displayName),
    status: readString(record.status),
    ownership: readString(record.ownership),
    cleanupPolicy: readString(record.cleanupPolicy),
    labels: readStringArray(record.labels),
    reason: readString(record.reason),
    createdAt: readString(record.createdAt),
    updatedAt: readString(record.updatedAt),
    lastObservedAt: readString(record.lastObservedAt),
  });
}

function normalizeNodeSummary(value: unknown): RemoteFleetNodeSummary | null {
  const record = readRecord(value);
  const id = readString(record.id);
  if (!id) return null;
  return compactRemoteFleetSummary({
    id,
    connectionId: readString(record.connectionId),
    environmentId: readString(record.environmentId),
    managedResourceId: readString(record.managedResourceId),
    displayName: readString(record.displayName),
    description: readString(record.description),
    targetKind: readNodeTargetKind(record.targetKind),
    endpointUrl: readString(record.endpointUrl),
    status: readString(record.status),
    labels: readStringArray(record.labels),
    enabled: readBoolean(record.enabled),
    lastSeenAt: readString(record.lastSeenAt),
    reason: readString(record.reason),
  });
}

function normalizeAgentSummary(value: unknown): RemoteFleetAgentSummary | null {
  const record = readRecord(value);
  const id = readString(record.id);
  if (!id) return null;
  return compactRemoteFleetSummary({
    id,
    connectionId: readString(record.connectionId),
    environmentId: readString(record.environmentId),
    managedResourceId: readString(record.managedResourceId),
    nodeId: readString(record.nodeId),
    displayName: readString(record.displayName),
    runtimeId: readString(record.runtimeId),
    status: readString(record.status),
    capabilities: readStringArray(record.capabilities),
    model: readString(record.model),
  });
}

function normalizeRuntimeSummary(value: unknown): RemoteFleetRuntimeSummary | null {
  const record = readRecord(value);
  const id = readString(record.id);
  if (!id) return null;
  return compactRemoteFleetSummary({
    id,
    connectionId: readString(record.connectionId),
    environmentId: readString(record.environmentId),
    managedResourceId: readString(record.managedResourceId),
    nodeId: readString(record.nodeId),
    agentId: readString(record.agentId),
    displayName: readString(record.displayName),
    status: readString(record.status),
    endpointId: readString(record.endpointId),
    startedAt: readString(record.startedAt),
    reason: readString(record.reason),
  });
}

function normalizeEndpointSummary(value: unknown): RemoteFleetEndpointSummary | null {
  const record = readRecord(value);
  const id = readString(record.id);
  if (!id) return null;
  return compactRemoteFleetSummary({
    id,
    connectionId: readString(record.connectionId),
    environmentId: readString(record.environmentId),
    managedResourceId: readString(record.managedResourceId),
    nodeId: readString(record.nodeId),
    runtimeId: readString(record.runtimeId),
    url: readString(record.url),
    protocol: readString(record.protocol),
    status: readString(record.status),
    lastProbeAt: readString(record.lastProbeAt),
    labels: readStringArray(record.labels),
  });
}

function normalizeCapabilitySummary(value: unknown): RemoteFleetCapabilitySummary | null {
  const record = readRecord(value);
  const id = readString(record.id);
  if (!id) return null;
  return compactRemoteFleetSummary({
    id,
    connectionId: readString(record.connectionId),
    environmentId: readString(record.environmentId),
    managedResourceId: readString(record.managedResourceId),
    nodeId: readString(record.nodeId),
    runtimeId: readString(record.runtimeId),
    endpointId: readString(record.endpointId),
    displayName: readString(record.displayName),
    operationIds: readStringArray(record.operationIds),
    status: readString(record.status),
  });
}

function normalizeCommandSummary(value: unknown): RemoteFleetCommandSummary | null {
  const record = readRecord(value);
  const id = readString(record.id);
  if (!id) return null;
  return compactRemoteFleetSummary({
    id,
    connectionId: readString(record.connectionId),
    environmentId: readString(record.environmentId),
    managedResourceId: readString(record.managedResourceId),
    nodeId: readString(record.nodeId),
    agentId: readString(record.agentId),
    runtimeId: readString(record.runtimeId),
    endpointId: readString(record.endpointId),
    command: readString(record.command),
    status: readString(record.status),
    createdAt: readString(record.createdAt),
    updatedAt: readString(record.updatedAt),
    message: readString(record.message),
  });
}

function normalizeLeaseSummary(value: unknown): RemoteFleetLeaseSummary | null {
  const record = readRecord(value);
  const id = readString(record.id);
  if (!id) return null;
  return compactRemoteFleetSummary({
    id,
    endpointId: readString(record.endpointId),
    ownerKind: readString(record.ownerKind),
    ownerId: readString(record.ownerId),
    status: readString(record.status),
    expiresAt: readString(record.expiresAt),
  });
}

function normalizeTerminalSessionSummary(value: unknown): RemoteFleetTerminalSessionSummary | null {
  const record = readRecord(value);
  const id = readString(record.id);
  const nodeId = readString(record.nodeId);
  if (!id || !nodeId) return null;
  return compactRemoteFleetSummary({
    id,
    nodeId,
    runtimeId: readString(record.runtimeId),
    endpointId: readString(record.endpointId),
    targetKind: readNodeTargetKind(record.targetKind),
    status: readString(record.status),
    createdAt: readString(record.createdAt),
    updatedAt: readString(record.updatedAt),
    expiresAt: readString(record.expiresAt),
    reason: readString(record.reason),
  });
}

function normalizeAuditEventSummary(value: unknown): RemoteFleetAuditEventSummary | null {
  const record = readRecord(value);
  const id = readString(record.id);
  if (!id) return null;
  return compactRemoteFleetSummary({
    id,
    eventName: readString(record.eventName),
    occurredAt: readString(record.occurredAt),
    nodeId: readString(record.nodeId),
    agentId: readString(record.agentId),
    runtimeId: readString(record.runtimeId),
    endpointId: readString(record.endpointId),
    commandId: readString(record.commandId),
    message: readString(record.message),
  });
}

function normalizeProjectionArray<T>(value: unknown, normalizeItem: (item: unknown) => T | null): T[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const normalized = normalizeItem(item);
    return normalized ? [normalized] : [];
  });
}

function normalizeEndpointMetricRef(value: unknown): RemoteFleetEndpointMetricRef | null {
  const record = readRecord(value);
  const id = readString(record.id);
  if (!id) return null;
  return compactRemoteFleetSummary({
    id,
    nodeId: readString(record.nodeId),
    runtimeId: readString(record.runtimeId),
    status: readString(record.status),
  });
}

function normalizeMetricsSnapshot(value: unknown): RemoteFleetMetricsSnapshot {
  const metrics = readRecord(value);
  const nodes = readRecord(metrics.nodes);
  const agents = readRecord(metrics.agents);
  const runtimes = readRecord(metrics.runtimes);
  const endpoints = readRecord(metrics.endpoints);
  const capabilities = readRecord(metrics.capabilities);
  const commands = readRecord(metrics.commands);
  const leases = readRecord(metrics.leases);
  const auditEvents = readRecord(metrics.auditEvents);

  return {
    nodes: {
      totalCount: readNumber(nodes.totalCount) ?? EMPTY_REMOTE_FLEET_METRICS.nodes.totalCount,
      countByStatus: normalizeMetricCounts(nodes.countByStatus),
      countByTargetKind: normalizeMetricCounts(nodes.countByTargetKind),
    },
    agents: {
      totalCount: readNumber(agents.totalCount) ?? EMPTY_REMOTE_FLEET_METRICS.agents.totalCount,
      countByStatus: normalizeMetricCounts(agents.countByStatus),
    },
    runtimes: {
      totalCount: readNumber(runtimes.totalCount) ?? EMPTY_REMOTE_FLEET_METRICS.runtimes.totalCount,
      countByStatus: normalizeMetricCounts(runtimes.countByStatus),
      countByRuntimeKind: normalizeMetricCounts(runtimes.countByRuntimeKind),
    },
    endpoints: {
      totalCount: readNumber(endpoints.totalCount) ?? EMPTY_REMOTE_FLEET_METRICS.endpoints.totalCount,
      countByStatus: normalizeMetricCounts(endpoints.countByStatus),
      drainingEndpoints: normalizeProjectionArray(endpoints.drainingEndpoints, normalizeEndpointMetricRef),
      retiredEndpoints: normalizeProjectionArray(endpoints.retiredEndpoints, normalizeEndpointMetricRef),
    },
    capabilities: {
      totalCount: readNumber(capabilities.totalCount) ?? EMPTY_REMOTE_FLEET_METRICS.capabilities.totalCount,
      countByStatus: normalizeMetricCounts(capabilities.countByStatus),
      staleCount: readNumber(capabilities.staleCount) ?? EMPTY_REMOTE_FLEET_METRICS.capabilities.staleCount,
    },
    commands: {
      totalCount: readNumber(commands.totalCount) ?? EMPTY_REMOTE_FLEET_METRICS.commands.totalCount,
      countByStatus: normalizeMetricCounts(commands.countByStatus),
      recentFailureCount: readNumber(commands.recentFailureCount) ?? EMPTY_REMOTE_FLEET_METRICS.commands.recentFailureCount,
    },
    leases: {
      totalCount: readNumber(leases.totalCount) ?? EMPTY_REMOTE_FLEET_METRICS.leases.totalCount,
      countByStatus: normalizeMetricCounts(leases.countByStatus),
      activeCount: readNumber(leases.activeCount) ?? EMPTY_REMOTE_FLEET_METRICS.leases.activeCount,
    },
    auditEvents: {
      totalCount: readNumber(auditEvents.totalCount) ?? EMPTY_REMOTE_FLEET_METRICS.auditEvents.totalCount,
      countByEventName: normalizeMetricCounts(auditEvents.countByEventName),
    },
  };
}

function normalizeSnapshot(value: unknown): RemoteFleetSnapshot {
  const snapshot = readRecord(value);
  return {
    connections: normalizeProjectionArray(snapshot.connections, normalizeConnectionSummary),
    environments: normalizeProjectionArray(snapshot.environments, normalizeEnvironmentSummary),
    managedResources: normalizeProjectionArray(snapshot.managedResources, normalizeManagedResourceSummary),
    nodes: normalizeProjectionArray(snapshot.nodes, normalizeNodeSummary),
    agents: normalizeProjectionArray(snapshot.agents, normalizeAgentSummary),
    runtimes: normalizeProjectionArray(snapshot.runtimes, normalizeRuntimeSummary),
    endpoints: normalizeProjectionArray(snapshot.endpoints, normalizeEndpointSummary),
    capabilities: normalizeProjectionArray(snapshot.capabilities, normalizeCapabilitySummary),
    commands: normalizeProjectionArray(snapshot.commands, normalizeCommandSummary),
    leases: normalizeProjectionArray(snapshot.leases, normalizeLeaseSummary),
    sessions: normalizeProjectionArray(snapshot.sessions, normalizeTerminalSessionSummary),
    auditEvents: normalizeProjectionArray(snapshot.auditEvents, normalizeAuditEventSummary),
    updatedAt: readString(snapshot.updatedAt),
  };
}

function normalizeSnapshotPatch(value: unknown): Partial<RemoteFleetSnapshot> {
  const snapshot = readRecord(value);
  return compactProjection({
    connections: Array.isArray(snapshot.connections) ? normalizeProjectionArray(snapshot.connections, normalizeConnectionSummary) : undefined,
    environments: Array.isArray(snapshot.environments) ? normalizeProjectionArray(snapshot.environments, normalizeEnvironmentSummary) : undefined,
    managedResources: Array.isArray(snapshot.managedResources) ? normalizeProjectionArray(snapshot.managedResources, normalizeManagedResourceSummary) : undefined,
    nodes: Array.isArray(snapshot.nodes) ? normalizeProjectionArray(snapshot.nodes, normalizeNodeSummary) : undefined,
    agents: Array.isArray(snapshot.agents) ? normalizeProjectionArray(snapshot.agents, normalizeAgentSummary) : undefined,
    runtimes: Array.isArray(snapshot.runtimes) ? normalizeProjectionArray(snapshot.runtimes, normalizeRuntimeSummary) : undefined,
    endpoints: Array.isArray(snapshot.endpoints) ? normalizeProjectionArray(snapshot.endpoints, normalizeEndpointSummary) : undefined,
    capabilities: Array.isArray(snapshot.capabilities) ? normalizeProjectionArray(snapshot.capabilities, normalizeCapabilitySummary) : undefined,
    commands: Array.isArray(snapshot.commands) ? normalizeProjectionArray(snapshot.commands, normalizeCommandSummary) : undefined,
    leases: Array.isArray(snapshot.leases) ? normalizeProjectionArray(snapshot.leases, normalizeLeaseSummary) : undefined,
    sessions: Array.isArray(snapshot.sessions) ? normalizeProjectionArray(snapshot.sessions, normalizeTerminalSessionSummary) : undefined,
    auditEvents: Array.isArray(snapshot.auditEvents) ? normalizeProjectionArray(snapshot.auditEvents, normalizeAuditEventSummary) : undefined,
    updatedAt: readString(snapshot.updatedAt),
  });
}

function projectionFromSnapshot(snapshot: RemoteFleetSnapshot): RemoteFleetProjectionState {
  return {
    connections: snapshot.connections,
    environments: snapshot.environments,
    managedResources: snapshot.managedResources,
    nodes: snapshot.nodes,
    agents: snapshot.agents,
    runtimes: snapshot.runtimes,
    endpoints: snapshot.endpoints,
    capabilities: snapshot.capabilities,
    commands: snapshot.commands,
    leases: snapshot.leases,
    sessions: snapshot.sessions,
    auditEvents: snapshot.auditEvents,
  };
}

function projectionPatchFromSnapshot(snapshot: Partial<RemoteFleetSnapshot>): RemoteFleetProjectionPatch {
  return compactProjection({
    connections: snapshot.connections ? [...snapshot.connections] : undefined,
    environments: snapshot.environments ? [...snapshot.environments] : undefined,
    managedResources: snapshot.managedResources ? [...snapshot.managedResources] : undefined,
    nodes: snapshot.nodes ? [...snapshot.nodes] : undefined,
    agents: snapshot.agents ? [...snapshot.agents] : undefined,
    runtimes: snapshot.runtimes ? [...snapshot.runtimes] : undefined,
    endpoints: snapshot.endpoints ? [...snapshot.endpoints] : undefined,
    capabilities: snapshot.capabilities ? [...snapshot.capabilities] : undefined,
    commands: snapshot.commands ? [...snapshot.commands] : undefined,
    leases: snapshot.leases ? [...snapshot.leases] : undefined,
    sessions: snapshot.sessions ? [...snapshot.sessions] : undefined,
    auditEvents: snapshot.auditEvents ? [...snapshot.auditEvents] : undefined,
  });
}

function actionErrorMessage(_error: unknown, fallback: string): string {
  return fallback;
}

function normalizeCredentialWriteResult(value: unknown): RemoteFleetCredentialWriteResult {
  const record = readRecord(value);
  const credentialName = readString(record.credentialName);
  const credentialRefRecord = readRecord(record.credentialRef);
  const credentialRef = readString(credentialRefRecord.ref);
  if (!credentialName || credentialRefRecord.kind !== 'secret-ref' || !credentialRef) {
    throw new Error('Remote Fleet credential write response is missing credentialName or credentialRef');
  }
  return { credentialName, credentialRef: { kind: 'secret-ref', ref: credentialRef } };
}

function normalizeTerminalConnection(value: unknown): RemoteFleetTerminalConnection {
  const record = readRecord(value);
  const sessionId = readString(record.sessionId);
  const ticket = readString(record.ticket);
  const websocketPath = readString(record.websocketPath);
  const expiresAt = readString(record.expiresAt);
  if (!sessionId || !ticket || !websocketPath || !expiresAt) {
    throw new Error('Remote Fleet terminal connection response is missing sessionId, ticket, websocketPath, or expiresAt');
  }
  return { sessionId, ticket, websocketPath, expiresAt };
}

function normalizeTerminalOpenResult(value: unknown): RemoteFleetTerminalOpenResult {
  const record = readRecord(value);
  const session = normalizeTerminalSessionSummary(record.session);
  if (!session) {
    throw new Error('Remote Fleet terminal response is missing session');
  }
  return {
    session,
    terminalConnection: normalizeTerminalConnection(record.terminalConnection),
  };
}

function normalizeRemoteFleetActionPayload(value: unknown): RemoteFleetActionPayload {
  const payload = readRecord(value);
  return compactProjection({
    snapshot: payload.snapshot === null ? null : payload.snapshot === undefined ? undefined : normalizeSnapshotPatch(payload.snapshot),
    connection: normalizeConnectionSummary(payload.connection) ?? undefined,
    environment: normalizeEnvironmentSummary(payload.environment) ?? undefined,
    environments: Array.isArray(payload.environments) ? normalizeProjectionArray(payload.environments, normalizeEnvironmentSummary) : undefined,
    managedResource: normalizeManagedResourceSummary(payload.managedResource) ?? undefined,
    managedResources: Array.isArray(payload.managedResources) ? normalizeProjectionArray(payload.managedResources, normalizeManagedResourceSummary) : undefined,
    node: normalizeNodeSummary(payload.node) ?? undefined,
    agent: normalizeAgentSummary(payload.agent) ?? undefined,
    runtime: normalizeRuntimeSummary(payload.runtime) ?? undefined,
    endpoint: normalizeEndpointSummary(payload.endpoint) ?? undefined,
    capability: normalizeCapabilitySummary(payload.capability) ?? undefined,
    command: normalizeCommandSummary(payload.command) ?? undefined,
    commands: Array.isArray(payload.commands) ? normalizeProjectionArray(payload.commands, normalizeCommandSummary) : undefined,
    leases: Array.isArray(payload.leases) ? normalizeProjectionArray(payload.leases, normalizeLeaseSummary) : undefined,
    sessions: Array.isArray(payload.sessions) ? normalizeProjectionArray(payload.sessions, normalizeTerminalSessionSummary) : undefined,
    session: normalizeTerminalSessionSummary(payload.session) ?? undefined,
    auditEvents: Array.isArray(payload.auditEvents) ? normalizeProjectionArray(payload.auditEvents, normalizeAuditEventSummary) : undefined,
    success: readBoolean(payload.success),
    message: readString(payload.message),
  });
}

function projectionPatchFromActionPayload(state: RemoteFleetState, payload: RemoteFleetActionPayload): RemoteFleetProjectionPatch {
  if (payload.snapshot) {
    return projectionPatchFromSnapshot(payload.snapshot);
  }

  return compactProjection({
    connections: payload.connection ? upsertById(state.connections, payload.connection) : undefined,
    environments: payload.environments ? [...payload.environments] : payload.environment ? upsertById(state.environments, payload.environment) : undefined,
    managedResources: payload.managedResources ? [...payload.managedResources] : payload.managedResource ? upsertById(state.managedResources, payload.managedResource) : undefined,
    nodes: payload.node ? upsertById(state.nodes, payload.node) : undefined,
    agents: payload.agent ? upsertById(state.agents, payload.agent) : undefined,
    runtimes: payload.runtime ? upsertById(state.runtimes, payload.runtime) : undefined,
    endpoints: payload.endpoint ? upsertById(state.endpoints, payload.endpoint) : undefined,
    capabilities: payload.capability ? upsertById(state.capabilities, payload.capability) : undefined,
    commands: payload.commands ? [...payload.commands] : payload.command ? upsertById(state.commands, payload.command) : undefined,
    leases: payload.leases ? [...payload.leases] : undefined,
    sessions: payload.sessions ? [...payload.sessions] : payload.session ? upsertById(state.sessions, payload.session) : undefined,
    auditEvents: payload.auditEvents ? [...payload.auditEvents] : undefined,
  });
}

function upsertById<T extends { readonly id: string }>(items: readonly T[], item: T): T[] {
  return [...items.filter((current) => current.id !== item.id), item]
    .sort((first, second) => first.id.localeCompare(second.id));
}

export const useRemoteFleetStore = create<RemoteFleetState>((set) => {
  async function runMutation(
    actionKey: string,
    path: string,
    body: Record<string, unknown>,
    fallbackErrorMessage: string,
    options: { readonly timeoutMs?: number } = {},
  ): Promise<RemoteFleetActionPayload> {
    set({ mutatingAction: actionKey, error: null });
    try {
      const payload = normalizeRemoteFleetActionPayload(await remoteFleetPost<unknown>(path, body, options));
      set((state) => ({
        ...projectionPatchFromActionPayload(state, payload),
        ready: payload.snapshot ? true : state.ready,
      }));
      return payload;
    } catch (error) {
      set({ error: actionErrorMessage(error, fallbackErrorMessage) });
      throw error;
    } finally {
      set((state) => ({ mutatingAction: state.mutatingAction === actionKey ? null : state.mutatingAction }));
    }
  }

  return {
    ...projectionFromSnapshot(EMPTY_REMOTE_FLEET_SNAPSHOT),
    metrics: null,
    ready: false,
    loading: false,
    mutatingAction: null,
    error: null,

    refresh: async () => {
      set({ loading: true, error: null });
      try {
        const snapshot = normalizeSnapshot(await hostApiFetch<unknown>('/api/remote-fleet/snapshot'));
        set({
          ...projectionFromSnapshot(snapshot),
          ready: true,
          loading: false,
        });
      } catch (error) {
        set({ loading: false, error: actionErrorMessage(error, '加载 Remote Fleet 失败') });
        throw error;
      }
    },

    loadMetrics: async () => {
      const actionKey = 'load-metrics';
      set({ mutatingAction: actionKey, error: null });
      try {
        const metrics = normalizeMetricsSnapshot(await hostApiFetch<unknown>('/api/remote-fleet/metrics'));
        set({ metrics });
        return metrics;
      } catch (error) {
        set({ error: actionErrorMessage(error, '加载 Remote Fleet metrics 失败') });
        throw error;
      } finally {
        set((state) => ({ mutatingAction: state.mutatingAction === actionKey ? null : state.mutatingAction }));
      }
    },

    registerConnection: async (connection) => {
      const actionKey = `register-connection:${connection.id ?? 'new-connection'}`;
      return await runMutation(actionKey, '/api/remote-fleet/register-connection', { connection }, '注册远端连接失败');
    },

    probeConnection: async (connectionId) => {
      return await runMutation(`probe-connection:${connectionId}`, '/api/remote-fleet/probe-connection', { connectionId }, '探测远端连接失败');
    },

    deleteConnection: async (connectionId) => {
      return await runMutation(`delete-connection:${connectionId}`, '/api/remote-fleet/delete-connection', { connectionId }, '删除远端连接失败');
    },

    registerEnvironment: async (environment) => {
      const actionKey = `register-environment:${environment.id ?? 'new-environment'}`;
      return await runMutation(actionKey, '/api/remote-fleet/register-environment', { environment }, '注册 Remote Fleet environment 失败');
    },

    deployEnvironment: async (environmentId) => {
      return await runMutation(
        `deploy-environment:${environmentId}`,
        '/api/remote-fleet/deploy-environment',
        { environmentId },
        '部署 Remote Fleet environment 失败',
        { timeoutMs: REMOTE_FLEET_BOOTSTRAP_REQUEST_TIMEOUT_MS },
      );
    },

    deleteEnvironment: async (environmentId) => {
      return await runMutation(`delete-environment:${environmentId}`, '/api/remote-fleet/delete-environment', { environmentId }, '删除 Remote Fleet environment 失败');
    },

    register: async (node) => {
      const actionKey = `register:${node.id ?? 'new-node'}`;
      return await runMutation(actionKey, '/api/remote-fleet/register', { node }, '注册远端节点失败');
    },

    remove: async (nodeId) => {
      return await runMutation(`remove-node:${nodeId}`, '/api/remote-fleet/remove-node', { nodeId }, '移除远端节点失败');
    },

    probe: async (nodeId) => {
      return await runMutation(`probe:${nodeId}`, '/api/remote-fleet/probe', { nodeId }, '探测远端节点失败');
    },

    install: async (nodeId) => {
      return await runMutation(
        `install-agent:${nodeId}`,
        '/api/remote-fleet/install-agent',
        { nodeId },
        '执行 Remote Fleet 安装或环境部署失败',
        { timeoutMs: REMOTE_FLEET_BOOTSTRAP_REQUEST_TIMEOUT_MS },
      );
    },

    writeCredential: async (input) => {
      const actionKey = `write-credential:${input.credentialId}:${input.credentialName}`;
      set({ mutatingAction: actionKey, error: null });
      try {
        return normalizeCredentialWriteResult(await remoteFleetPost<unknown>('/api/remote-fleet/write-credential', {
          operationId: input.operationId,
          credentialId: input.credentialId,
          credentialName: input.credentialName,
          plaintextValue: input.plaintextValue,
        }));
      } catch (error) {
        set({ error: actionErrorMessage(error, '写入 Remote Fleet credential 失败') });
        throw error;
      } finally {
        set((state) => ({ mutatingAction: state.mutatingAction === actionKey ? null : state.mutatingAction }));
      }
    },

    openTerminal: async (target) => {
      const targetKey = target.endpointId ?? target.runtimeId ?? target.nodeId ?? 'unknown';
      const actionKey = `terminal-open:${targetKey}`;
      set({ mutatingAction: actionKey, error: null });
      try {
        const result = normalizeTerminalOpenResult(await remoteFleetPost<unknown>('/api/remote-fleet/terminal/open', compactTerminalOpenTarget(target)));
        set((state) => ({ sessions: upsertById(state.sessions, result.session) }));
        return result;
      } catch (error) {
        set({ error: '打开 Remote Fleet 终端失败' });
        throw error;
      } finally {
        set((state) => ({ mutatingAction: state.mutatingAction === actionKey ? null : state.mutatingAction }));
      }
    },

    reconnectTerminal: async (sessionId) => {
      const actionKey = `terminal-reconnect:${sessionId}`;
      set({ mutatingAction: actionKey, error: null });
      try {
        const result = normalizeTerminalOpenResult(await remoteFleetPost<unknown>('/api/remote-fleet/terminal/reconnect', { sessionId }));
        set((state) => ({ sessions: upsertById(state.sessions, result.session) }));
        return result;
      } catch (error) {
        set({ error: '重新连接 Remote Fleet 终端失败' });
        throw error;
      } finally {
        set((state) => ({ mutatingAction: state.mutatingAction === actionKey ? null : state.mutatingAction }));
      }
    },

    closeTerminal: async (sessionId, reason) => {
      return await runMutation(
        `terminal-close:${sessionId}`,
        '/api/remote-fleet/terminal/close',
        compactProjection({ sessionId, reason }),
        '关闭 Remote Fleet 终端失败',
      );
    },

    listTerminalSessions: async () => {
      const actionKey = 'terminal-sessions';
      set({ mutatingAction: actionKey, error: null });
      try {
        const payload = readRecord(await hostApiFetch<unknown>('/api/remote-fleet/terminal/sessions'));
        const sessions = normalizeProjectionArray(payload.sessions, normalizeTerminalSessionSummary);
        set({ sessions });
        return sessions;
      } catch (error) {
        set({ error: actionErrorMessage(error, '加载 Remote Fleet 终端会话失败') });
        throw error;
      } finally {
        set((state) => ({ mutatingAction: state.mutatingAction === actionKey ? null : state.mutatingAction }));
      }
    },

    revoke: async (agentId) => {
      return await runMutation(`revoke-agent:${agentId}`, '/api/remote-fleet/revoke-agent', { agentId }, '撤销 RuntimeAgent 失败');
    },

    start: async (runtime) => {
      return await runMutation(
        `start:${runtime.id}`,
        '/api/capabilities/execute',
        createRemoteFleetCapabilityExecutePayload('remoteFleet.runtime.start', runtime),
        '启动远端 runtime 失败',
      );
    },

    stop: async (runtime) => {
      return await runMutation(
        `stop:${runtime.id}`,
        '/api/capabilities/execute',
        createRemoteFleetCapabilityExecutePayload('remoteFleet.runtime.stop', runtime),
        '停止远端 runtime 失败',
      );
    },

    drain: async (endpointId) => {
      return await runMutation(`drain-endpoint:${endpointId}`, '/api/remote-fleet/drain-endpoint', { endpointId }, 'Drain 远端 endpoint 失败');
    },

    retire: async (endpointId) => {
      return await runMutation(`retire-endpoint:${endpointId}`, '/api/remote-fleet/retire-endpoint', { endpointId }, 'Retire 远端 endpoint 失败');
    },

    sync: async (endpoint) => {
      const runtime = runtimeForEndpoint(endpoint);
      return await runMutation(
        `sync-capabilities:${endpoint.id}`,
        '/api/capabilities/execute',
        createRemoteFleetCapabilityExecutePayload('remoteFleet.capabilities.sync', runtime),
        '同步远端 capabilities 失败',
      );
    },

    listCommands: async () => {
      const actionKey = 'list-commands';
      set({ mutatingAction: actionKey, error: null });
      try {
        const payload = readRecord(await hostApiFetch<unknown>('/api/remote-fleet/list-commands'));
        const commands = normalizeProjectionArray(payload.commands, normalizeCommandSummary);
        set({ commands });
        return commands;
      } catch (error) {
        set({ error: actionErrorMessage(error, '加载远端命令失败') });
        throw error;
      } finally {
        set((state) => ({ mutatingAction: state.mutatingAction === actionKey ? null : state.mutatingAction }));
      }
    },

    listAuditEvents: async () => {
      const actionKey = 'list-audit-events';
      set({ mutatingAction: actionKey, error: null });
      try {
        const payload = readRecord(await hostApiFetch<unknown>('/api/remote-fleet/list-audit-events'));
        const auditEvents = normalizeProjectionArray(payload.auditEvents, normalizeAuditEventSummary);
        set({ auditEvents });
        return auditEvents;
      } catch (error) {
        set({ error: actionErrorMessage(error, '加载远端审计事件失败') });
        throw error;
      } finally {
        set((state) => ({ mutatingAction: state.mutatingAction === actionKey ? null : state.mutatingAction }));
      }
    },

    clearError: () => set((state) => (state.error ? { error: null } : state)),
  };
});
