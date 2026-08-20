import type { IncomingMessage } from 'node:http';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import type { RuntimeHostDeliveryIssuer } from '../bootstrap';

const DECISION_TTL_MS = 30_000;
export const PUBLIC_FLEET_TERMINAL_STREAM_PATH = '/api/remote-fleet/terminal/stream';
const PRIVATE_FLEET_TERMINAL_STREAM_PATH = '/api/fleet/terminal';
const UNAVAILABLE = {
  success: false,
  error: 'Fleet data is unavailable',
} as const;

type FleetReadOperation =
  | 'fleet.targets.list'
  | 'fleet.snapshot.get'
  | 'fleet.topology.get'
  | 'fleet.connections.list'
  | 'fleet.capabilities.list'
  | 'fleet.environments.list'
  | 'fleet.resources.list'
  | 'fleet.commands.list'
  | 'fleet.terminals.list'
  | 'fleet.audit.list'
  | 'fleet.leases.list'
  | 'fleet.metrics.get'
  | 'fleet.selector.preview';

type FleetMutationOperation =
  | 'fleet.targets.put'
  | 'fleet.targets.remove'
  | 'fleet.commands.submit'
  | 'fleet.commands.submit.node'
  | 'fleet.commands.begin'
  | 'fleet.commands.accept'
  | 'fleet.commands.reject'
  | 'fleet.commands.unknown'
  | 'fleet.commands.replay'
  | 'fleet.connections.upsert' | 'fleet.connections.remove' | 'fleet.connections.probe.begin' | 'fleet.connections.probe.complete'
  | 'fleet.environments.register' | 'fleet.environments.deploy.begin' | 'fleet.environments.deploy.complete' | 'fleet.environments.deploy.fail' | 'fleet.environments.delete.begin' | 'fleet.environments.delete.complete' | 'fleet.environments.delete.fail'
  | 'fleet.resources.register' | 'fleet.resources.provision.begin' | 'fleet.resources.provision.complete' | 'fleet.resources.delete.begin' | 'fleet.resources.delete.complete' | 'fleet.resources.delete.fail'
  | 'fleet.nodes.upsert' | 'fleet.nodes.retire' | 'fleet.agents.upsert' | 'fleet.agents.revoke' | 'fleet.runtimes.upsert' | 'fleet.capabilities.sync.begin' | 'fleet.capabilities.sync.complete' | 'fleet.terminals.open' | 'fleet.terminals.reconnect' | 'fleet.terminals.close.begin' | 'fleet.terminals.close.complete' | 'fleet.terminals.close' | 'fleet.runtimes.start.begin' | 'fleet.runtimes.start.complete' | 'fleet.runtimes.stop.begin' | 'fleet.runtimes.stop.complete' | 'fleet.runtimes.retire' | 'fleet.endpoints.upsert' | 'fleet.endpoints.drain' | 'fleet.endpoints.retire' | 'fleet.endpoints.probe.begin';

type FleetOperation = FleetReadOperation | FleetMutationOperation;

type FleetMutationOutcome =
  | 'submitted' | 'alreadySubmitted' | 'completed' | 'rejected' | 'accepted' | 'outcomeUnknown'
  | 'alreadyRecorded' | 'replayed' | 'replayAuthorized'
  | 'targetUpdated' | 'targetRemoved'
  | 'connectionUpdated' | 'connectionRemoved' | 'environmentRegistered' | 'resourceRegistered'
  | 'nodeUpdated' | 'nodeRetired' | 'agentUpdated' | 'agentRevoked'
  | 'runtimeUpdated' | 'runtimeLifecycleUpdated' | 'runtimeRetired'
  | 'endpointUpdated' | 'endpointDrained' | 'endpointRetired'
  | 'probeStarted' | 'probeCompleted' | 'probeUnknown' | 'probeRejected'
  | 'capabilitySyncStarted' | 'capabilitySyncCompleted'
  | 'deploymentCompleted' | 'deploymentFailed' | 'deploymentUnknown'
  | 'deletionCompleted' | 'deletionFailed' | 'deletionUnknown'
  | 'provisioningCompleted' | 'provisioningFailed' | 'provisioningUnknown'
  | 'terminalOpened' | 'terminalReconnected' | 'terminalClosing' | 'terminalClosed';

export type FleetMutationResult = Readonly<{
  outcome: FleetMutationOutcome;
  commandId?: string;
  dispatchId?: string;
  attempt?: number;
  target?: FleetTarget;
}>;

export type FleetTerminalCloseResult = Readonly<{
  outcome: 'terminalClosed' | 'error';
}>;

export type FleetTerminalSessionSummary = Readonly<{
  id: string;
  nodeId: string;
  runtimeId?: string;
  endpointId?: string;
  targetKind?: 'ssh-host' | 'container' | 'vm' | 'k8s-pod' | 'custom';
  status: 'opening' | 'connected' | 'closing' | 'closed' | 'failed' | 'expired';
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  reason?: string;
}>;

export type FleetTerminalConnection = Readonly<{
  sessionId: string;
  ticket: string;
  websocketPath: typeof PUBLIC_FLEET_TERMINAL_STREAM_PATH;
  expiresAt: string;
}>;

export type FleetTerminalSessionResult = Readonly<{
  session: FleetTerminalSessionSummary;
  terminalConnection: FleetTerminalConnection;
}>;

type FleetMutationRequest = Readonly<{
  operation: FleetMutationOperation;
  input: Readonly<Record<string, unknown>>;
}>;

export type FleetTarget = Readonly<{
  id: string;
  revision: number;
  kind: 'docker' | 'kubernetes' | 'ssh' | 'custom';
}>;

type FleetTopologyAssociation = Readonly<{
  connectionId: string | null;
  environmentId: string | null;
  managedResourceId: string | null;
}>;

export type FleetNode = Readonly<FleetTopologyAssociation & {
  id: string;
  health: 'unknown' | 'online' | 'offline' | 'disabled' | 'error';
  observedAt: string;
  freshness: 'current' | 'stale' | 'unknown' | 'pruned';
}>;

export type FleetAgent = Readonly<FleetTopologyAssociation & {
  id: string;
  nodeId: string;
  observedAt: string;
  freshness: 'current' | 'stale' | 'unknown' | 'pruned';
}>;

export type FleetRuntime = Readonly<FleetTopologyAssociation & {
  id: string;
  nodeId: string;
  agentId: string;
  kind: 'openClaw' | 'matchaAgent' | 'plugin';
  state: 'discovered' | 'running' | 'stopped' | 'degraded' | 'retired';
  observedAt: string;
  freshness: 'current' | 'stale' | 'unknown' | 'pruned';
}>;

export type FleetEndpoint = Readonly<FleetTopologyAssociation & {
  id: string;
  nodeId: string;
  runtimeId: string;
  health: 'unknown' | 'ready' | 'busy' | 'draining' | 'unhealthy' | 'retired';
  observedAt: string;
  freshness: 'current' | 'stale' | 'unknown' | 'pruned';
}>;

export type FleetCapability = Readonly<{
  id: string;
  scope: 'endpoint' | 'agent' | 'session';
  endpointId: string;
  nodeId: string;
  runtimeId: string;
  availability: 'available' | 'unavailable' | 'unknown';
  observedAt: string;
  source: 'discovery' | 'healthProbe' | 'runtimeAgent';
  freshness: 'current' | 'stale' | 'unknown' | 'pruned';
}>;

type FleetConnectionState =
  | Readonly<{ kind: 'registered' }>
  | Readonly<{ kind: 'probing' }>
  | Readonly<{ kind: 'ready'; observedAt: string }>
  | Readonly<{ kind: 'unhealthy'; observedAt: string | null }>
  | Readonly<{ kind: 'deleted'; deletedAt: string }>
  | Readonly<{ kind: 'failed' }>;
type FleetEnvironmentState =
  | Readonly<{ kind: 'registered' }>
  | Readonly<{ kind: 'deploying' }>
  | Readonly<{ kind: 'ready'; readyAt: string }>
  | Readonly<{ kind: 'deleting' }>
  | Readonly<{ kind: 'deleted'; deletedAt: string }>
  | Readonly<{ kind: 'orphaned' }>
  | Readonly<{ kind: 'failed' }>;
type FleetResourceState =
  | Readonly<{ kind: 'observed' }>
  | Readonly<{ kind: 'provisioning' }>
  | Readonly<{ kind: 'ready'; observedAt: string }>
  | Readonly<{ kind: 'deleting' }>
  | Readonly<{ kind: 'deleted'; deletedAt: string }>
  | Readonly<{ kind: 'conflict' }>
  | Readonly<{ kind: 'failed' }>;
type FleetCommandTarget =
  | Readonly<{ kind: 'node'; nodeId: string }>
  | Readonly<{ kind: 'runtime'; nodeId: string; runtimeId: string }>
  | Readonly<{ kind: 'endpoint'; nodeId: string; runtimeId: string; endpointId: string }>;
type FleetCommandState =
  | Readonly<{ kind: 'queued'; queuedAt: string }>
  | Readonly<{ kind: 'running'; startedAt: string }>
  | Readonly<{ kind: 'succeeded'; completedAt: string }>
  | Readonly<{ kind: 'failed'; completedAt: string; failure: 'rejected' | 'unavailable' | 'executionFailed' }>
  | Readonly<{ kind: 'cancelled'; completedAt: string; reason: 'requested' | 'superseded' | null }>
  | Readonly<{ kind: 'timedOut'; completedAt: string }>
  | Readonly<{ kind: 'outcomeUnknown'; observedAt: string }>;

export type FleetConnection = Readonly<{
  id: string;
  kind: 'sshHost' | 'container' | 'vm' | 'kubernetesPod' | 'custom';
  displayName: string;
  endpoint: string | null;
  labels: readonly string[];
  publicConfig: Readonly<Record<string, string>>;
  state: FleetConnectionState;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}>;

export type FleetEnvironment = Readonly<{
  id: string;
  connectionId: string;
  displayName: string;
  kind: 'sshWorkdir' | 'dockerContainer' | 'kubernetesWorkload' | 'vmWorkdir' | 'custom';
  labels: readonly string[];
  publicConfig: Readonly<Record<string, string>>;
  state: FleetEnvironmentState;
  enabled: boolean;
  managedResourceCount: number;
  createdAt: string;
  updatedAt: string;
}>;

export type FleetResource = Readonly<{
  id: string;
  connectionId: string;
  environmentId: string;
  provider: 'docker' | 'kubernetes' | 'ssh' | 'vm' | 'custom';
  remoteResourceId: string;
  kind:
    | 'dockerContainer'
    | 'kubernetesWorkload'
    | 'kubernetesDeployment'
    | 'kubernetesService'
    | 'kubernetesSecret'
    | 'sshAgentInstallation'
    | 'vmAgentInstallation'
    | 'custom';
  ownership: 'matchaManaged' | 'unverified' | 'external';
  cleanupPolicy: 'deleteOnEnvironmentDelete' | 'uninstallAgentOnly' | 'orphan' | 'none';
  state: FleetResourceState;
  tombstone: boolean;
  createdAt: string;
  updatedAt: string;
}>;

export type FleetTerminalSession = Readonly<{
  id: string;
  targetId: string;
  provider: string;
  generation: number;
  status: 'Opening' | 'Connected' | 'Closing' | 'Closed' | 'Failed' | 'Expired';
  expiresAt: string;
}>;

export type FleetCommand = Readonly<{
  commandId: string;
  kind:
    | 'probeNode'
    | 'installAgent'
    | 'startRuntime'
    | 'stopRuntime'
    | 'syncCapabilities'
    | 'upgradeAgent'
    | 'mountWorkspace'
    | 'exposePort';
  target: FleetCommandTarget;
  state: FleetCommandState;
  createdAt: string;
  updatedAt: string;
}>;

export type FleetAudit = Readonly<{
  sequence: number;
  eventName: string;
  occurredAt: string;
  actorId: string | null;
  connectionId: string | null;
  environmentId: string | null;
  managedResourceId: string | null;
  nodeId: string | null;
  agentId: string | null;
  runtimeId: string | null;
  endpointId: string | null;
  commandId: string | null;
}>;

export type FleetLease = Readonly<{
  leaseId: string;
  endpointId: string;
  owner: Readonly<{ kind: 'manualOperation' | 'runtimeStart' | 'session' | 'teamRun'; id: string }>;
  acquiredAt: string;
  state: Readonly<
    | { kind: 'active'; expiresAt: string }
    | { kind: 'released'; releasedAt: string }
    | { kind: 'expired'; expiredAt: string }
  >;
}>;

type FleetMetricGroup = Readonly<Record<string, number>>;
type FleetEndpointMetricRef = Readonly<{ id: string; nodeId: string; runtimeId: string }>;
type FleetEndpointMetrics = Readonly<{ total: number; unknown: number; ready: number; busy: number; draining: number; unhealthy: number; retired: number; drainingEndpoints: readonly FleetEndpointMetricRef[]; retiredEndpoints: readonly FleetEndpointMetricRef[] }>;
export type FleetMetrics = Readonly<{
  nodes: FleetMetricGroup;
  agents: FleetMetricGroup;
  capabilities: FleetMetricGroup;
  runtimes: FleetMetricGroup;
  endpoints: FleetEndpointMetrics;
  commands: FleetMetricGroup;
  audit: Readonly<{ total: number; eventCounts: Readonly<Record<string, number>> }>;
  leases: FleetMetricGroup;
}>;

type FleetSnapshot = Readonly<{
  connections: readonly FleetSnapshotConnection[];
  environments: readonly FleetSnapshotEnvironment[];
  managedResources: readonly FleetSnapshotManagedResource[];
  nodes: readonly FleetSnapshotNode[];
  agents: readonly FleetSnapshotAgent[];
  runtimes: readonly FleetSnapshotRuntime[];
  endpoints: readonly FleetSnapshotEndpoint[];
  capabilities: readonly FleetSnapshotCapability[];
  commands: readonly FleetSnapshotCommand[];
  leases: readonly FleetSnapshotLease[];
  sessions: readonly FleetSnapshotSession[];
  auditEvents: readonly FleetSnapshotAuditEvent[];
  updatedAt: string;
}>;

type FleetSnapshotConnection = Readonly<{
  id: string;
  displayName: string;
  connectionKind: 'ssh-host' | 'container' | 'vm' | 'k8s-pod' | 'custom';
  status: 'unknown' | 'online' | 'offline' | 'disabled' | 'error';
  labels: readonly string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}>;

type FleetSnapshotEnvironment = Readonly<{
  id: string;
  connectionId: string;
  displayName: string;
  environmentKind: 'ssh-workdir' | 'docker-container' | 'k8s-workload' | 'vm-workdir' | 'custom';
  status: 'registered' | 'deploying' | 'ready' | 'deleting' | 'deleted' | 'orphaned' | 'failed';
  labels: readonly string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}>;

type FleetSnapshotManagedResource = Readonly<{
  id: string;
  connectionId: string;
  environmentId: string;
  providerKind: 'docker' | 'k8s' | 'ssh' | 'vm' | 'custom';
  resourceKind: 'docker-container' | 'k8s-workload' | 'k8s-deployment' | 'k8s-service' | 'k8s-secret' | 'ssh-agent-installation' | 'vm-agent-installation' | 'custom';
  remoteResourceId: string;
  status: 'observed' | 'provisioning' | 'ready' | 'deleting' | 'deleted' | 'conflict' | 'failed';
  ownership: 'matchaManaged' | 'unverified' | 'external';
  cleanupPolicy: 'deleteOnEnvironmentDelete' | 'uninstallAgentOnly' | 'orphan' | 'none';
  createdAt: string;
  updatedAt: string;
}>;

type FleetSnapshotNode = Readonly<{
  id: string;
  connectionId: string | null;
  environmentId: string | null;
  managedResourceId: string | null;
  status: 'unknown' | 'online' | 'offline' | 'disabled' | 'error';
  lastSeenAt: string;
}>;

type FleetSnapshotAgent = Readonly<{
  id: string;
  connectionId: string | null;
  environmentId: string | null;
  managedResourceId: string | null;
  nodeId: string;
}>;

type FleetSnapshotRuntime = Readonly<{
  id: string;
  connectionId: string | null;
  environmentId: string | null;
  managedResourceId: string | null;
  nodeId: string;
  agentId: string | null;
  status: 'unknown' | 'running' | 'stopped' | 'error';
  startedAt: string | null;
}>;

type FleetSnapshotEndpoint = Readonly<{
  id: string;
  connectionId: string | null;
  environmentId: string | null;
  managedResourceId: string | null;
  nodeId: string;
  runtimeId: string;
  status: 'unknown' | 'ready' | 'busy' | 'draining' | 'unhealthy' | 'retired';
  lastProbeAt: string;
}>;

type FleetSnapshotCapability = Readonly<{
  id: string;
  endpointId: string;
  nodeId: string;
  runtimeId: string;
  status: 'current' | 'unavailable' | 'unknown' | 'stale';
}>;

type FleetSnapshotCommand = Readonly<{
  id: string;
  command: 'probeNode' | 'installAgent' | 'startRuntime' | 'stopRuntime' | 'syncCapabilities' | 'upgradeAgent' | 'mountWorkspace' | 'exposePort';
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed-out' | 'unknown';
  createdAt: string;
  updatedAt: string;
  nodeId?: string;
  runtimeId?: string;
  endpointId?: string;
}>;

type FleetSnapshotLease = Readonly<{
  id: string;
  endpointId: string;
  ownerKind: 'manualOperation' | 'runtimeStart' | 'session' | 'teamRun';
  ownerId: string;
  status: 'active' | 'released' | 'expired';
  expiresAt: string | null;
}>;

type FleetSnapshotSession = Readonly<{
  id: string;
  nodeId: string;
  status: 'opening' | 'connected' | 'closing' | 'closed' | 'failed' | 'expired';
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}>;

type FleetSnapshotAuditEvent = Readonly<{
  id: string;
  eventName: string;
  occurredAt: string;
  connectionId: string | null;
  environmentId: string | null;
  managedResourceId: string | null;
  nodeId: string | null;
  agentId: string | null;
  runtimeId: string | null;
  endpointId: string | null;
  commandId: string | null;
}>;

type FleetSuccessBody =
  | Readonly<{ targets: readonly FleetTarget[] }>
  | FleetSnapshot
  | Readonly<{
      nodes: readonly FleetNode[];
      agents: readonly FleetAgent[];
      runtimes: readonly FleetRuntime[];
      endpoints: readonly FleetEndpoint[];
    }>
  | Readonly<{ connections: readonly FleetConnection[] }>
  | Readonly<{ capabilities: readonly FleetCapability[] }>
  | Readonly<{ environments: readonly FleetEnvironment[] }>
  | Readonly<{ resources: readonly FleetResource[] }>
  | Readonly<{ commands: readonly FleetCommand[] }>
  | Readonly<{ sessions: readonly FleetTerminalSession[] }>
  | Readonly<{ audit: readonly FleetAudit[] }>
  | Readonly<{ leases: readonly FleetLease[] }>
  | Readonly<{ metrics: FleetMetrics }>
  | FleetSelectorPreview;

export type FleetSelectorPreview = Readonly<{
  constraints: FleetSelectorConstraints;
  candidates: readonly FleetSelectorCandidate[];
  exclusions: readonly FleetSelectorExclusion[];
  unavailableConstraints: readonly FleetSelectorConstraintDimension[];
}>;
export type FleetSelectorConstraints = Readonly<{
  endpointIds: readonly string[];
  nodeIds: readonly string[];
  runtimeIds: readonly string[];
  labels: readonly string[];
  operationIds: readonly string[];
}>;
export type FleetSelectorCandidate = Readonly<{
  endpointId: string; nodeId: string; runtimeId: string;
  health: FleetEndpoint['health']; activeLeaseCount: number;
  capabilities: readonly Readonly<{ id: string; availability: FleetCapability['availability'] }>[];
}>;
export type FleetSelectorExclusion = Readonly<{
  endpointId: string; nodeId: string; runtimeId: string;
  reasons: readonly string[];
}>;
type FleetSelectorConstraintDimension = 'endpointIds' | 'nodeIds' | 'runtimeIds' | 'labels' | 'operationIds';

export type FleetTransportResponse = Readonly<{
  status: 200 | 503;
  body: FleetSuccessBody | typeof UNAVAILABLE;
}>;

export type FleetMutationTransportResponse = Readonly<{
  status: 200 | 503;
  body: FleetMutationResult | FleetTerminalCloseResult | FleetTerminalSessionResult | typeof UNAVAILABLE;
}>;

export interface FleetTransport {
  read(request: unknown): Promise<FleetTransportResponse>;
  mutate(request: unknown): Promise<FleetMutationTransportResponse>;
}

export function createFleetTransport(
  issuer: RuntimeHostDeliveryIssuer,
  port: number,
  fetcher: typeof fetch = fetch,
): FleetTransport {
  const url = `http://127.0.0.1:${port}/api/fleet`;
  return {
    async read(request): Promise<FleetTransportResponse> {
      if (!isFleetReadRequest(request)) return { status: 503, body: UNAVAILABLE };
      return requestFleet(url, issuer, fetcher, request, 'fleet:read', (body) =>
        isSuccessResponse(body, request.operation) ? body : null,
      );
    },
    async mutate(request): Promise<FleetMutationTransportResponse> {
      if (!isFleetMutationRequest(request)) return { status: 503, body: UNAVAILABLE };
      return requestFleet(url, issuer, fetcher, request, 'fleet:write', (body) =>
        isFleetMutationResponse(body, request.operation) ? body : null,
      );
    },
  };
}

async function requestFleet<T extends FleetSuccessBody | FleetMutationResult | FleetTerminalCloseResult | FleetTerminalSessionResult>(
  url: string,
  issuer: RuntimeHostDeliveryIssuer,
  fetcher: typeof fetch,
  request: Readonly<{ operation: FleetOperation; input: Readonly<Record<string, unknown>> }>,
  scope: 'fleet:read' | 'fleet:write',
  decode: (body: unknown) => T | null,
): Promise<Readonly<{ status: 200 | 503; body: T | typeof UNAVAILABLE }>> {
  try {
    const response = await fetcher(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${issuer.signDecision({
          principal: 'electron-main-local',
          endpoint: '/api/fleet',
          scope,
          capability: request.operation,
          subject: 'fleet',
          expiresAt: Date.now() + DECISION_TTL_MS,
          revision: '1',
        })}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });
    const body: unknown = await response.json();
    const decoded = response.status === 200 ? decode(body) : null;
    if (decoded) return { status: 200, body: decoded };
  } catch {
    // Native transport details do not cross the Electron delivery boundary.
  }
  return { status: 503, body: UNAVAILABLE };
}

export function proxyFleetTerminalStreamUpgrade(
  port: number,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): void {
  const upstream = connect(port, '127.0.0.1');
  const closeBoth = () => {
    if (!socket.destroyed) socket.destroy();
    if (!upstream.destroyed) upstream.destroy();
  };
  upstream.once('connect', () => {
    upstream.write(buildTerminalUpgradeRequestHead(req));
    if (head.byteLength > 0) {
      upstream.write(head);
    }
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.once('error', closeBoth);
  socket.once('error', closeBoth);
  socket.once('close', () => {
    if (!upstream.destroyed) upstream.destroy();
  });
  upstream.once('close', () => {
    if (!socket.destroyed) socket.destroy();
  });
}

function buildTerminalUpgradeRequestHead(req: IncomingMessage): string {
  const requestLine = `${req.method ?? 'GET'} ${PRIVATE_FLEET_TERMINAL_STREAM_PATH} HTTP/${req.httpVersion}\r\n`;
  const headerLines = Object.entries(req.headers).flatMap(([name, value]) => {
    if (Array.isArray(value)) {
      return value.map((entry) => `${name}: ${entry}\r\n`);
    }
    return value === undefined ? [] : [`${name}: ${value}\r\n`];
  });
  return `${requestLine}${headerLines.join('')}\r\n`;
}

export function isFleetReadRequest(value: unknown): value is Readonly<{
  operation: FleetReadOperation;
  input: Readonly<{ kind: string }>;
}> {
  if (!isRecord(value) || !isRecord(value.input)) return false;
  const pairs: Readonly<Record<FleetReadOperation, string | undefined>> = {
    'fleet.targets.list': 'list', 'fleet.snapshot.get': 'snapshot', 'fleet.topology.get': 'topology',
    'fleet.connections.list': 'connections', 'fleet.capabilities.list': 'capabilities', 'fleet.environments.list': 'environments',
    'fleet.resources.list': 'resources', 'fleet.commands.list': 'commands',
    'fleet.terminals.list': 'terminalList', 'fleet.audit.list': 'audit', 'fleet.leases.list': 'leases', 'fleet.metrics.get': 'metrics',
    'fleet.selector.preview': undefined,
  };
  if (!hasExactKeys(value, ['operation', 'input']) || typeof value.operation !== 'string' || !Object.hasOwn(pairs, value.operation)) return false;
  if (value.operation === 'fleet.selector.preview') return isSelectorPreviewRequest(value.input);
  return hasExactKeys(value.input, ['kind']) && value.input.kind === pairs[value.operation as FleetReadOperation];
}

function isSelectorPreviewRequest(value: Record<string, unknown>): boolean {
  if (!hasExactKeys(value, ['kind', 'payload']) || value.kind !== 'selectorPreview' || !isRecord(value.payload)) return false;
  const payload = value.payload;
  return hasExactKeys(payload, ['endpointIds', 'nodeIds', 'runtimeIds', 'labels', 'operationIds'])
    && [payload.endpointIds, payload.nodeIds, payload.runtimeIds, payload.labels, payload.operationIds].every((items) => Array.isArray(items) && items.every(isText));
}

export function isFleetMutationRequest(value: unknown): value is FleetMutationRequest {
  if (!isRecord(value) || !hasExactKeys(value, ['operation', 'input']) || !isRecord(value.input)
    || typeof value.operation !== 'string' || !isMutationOperation(value.operation)) return false;
  const input = value.input;
  const validators: Readonly<Record<FleetMutationOperation, (input: Record<string, unknown>) => boolean>> = {
    'fleet.targets.put': (v) => hasExactKeys(v, ['kind', 'payload']) && v.kind === 'targetPut' && isTargetPutPayload(v.payload),
    'fleet.targets.remove': (v) => hasExactKeys(v, ['kind', 'payload']) && v.kind === 'targetRemove' && isRecord(v.payload) && hasExactKeys(v.payload, ['id']) && isIdentifier(v.payload.id),
    'fleet.commands.submit': (v) => hasExactKeys(v, ['kind', 'payload']) && v.kind === 'commandSubmit' && isCommandSubmitPayload(v.payload),
    'fleet.commands.submit.node': (v) => hasExactKeys(v, ['kind', 'payload']) && v.kind === 'nodeCommandSubmit' && isNodeCommandSubmitPayload(v.payload),
    'fleet.commands.begin': (v) => hasExactKeys(v, ['kind', 'payload']) && v.kind === 'commandBegin' && isPayload(v.payload, ['dispatchId']) && isIdentifier(v.payload.dispatchId),
    'fleet.commands.accept': (v) => isReceiptInput(v, 'commandAccept'),
    'fleet.commands.reject': (v) => isReceiptInput(v, 'commandReject'),
    'fleet.commands.unknown': (v) => isReceiptInput(v, 'commandUnknown'),
    'fleet.commands.replay': (v) => hasExactKeys(v, ['kind', 'payload']) && v.kind === 'commandReplay' && isPayload(v.payload, ['commandId', 'dispatchId']) && isIdentifier(v.payload.commandId) && isIdentifier(v.payload.dispatchId),
    'fleet.connections.upsert': (v) => hasExactKeys(v, ['kind', 'payload']) && v.kind === 'connectionUpsert' && isConnectionUpsertPayload(v.payload),
    'fleet.connections.remove': (v) => hasExactKeys(v, ['kind', 'payload']) && v.kind === 'connectionRemove' && isPayload(v.payload, ['id']) && isIdentifier(v.payload.id),
    'fleet.environments.register': (v) => hasExactKeys(v, ['kind', 'payload']) && v.kind === 'environmentRegister' && isEnvironmentRegisterPayload(v.payload),
    'fleet.resources.register': (v) => hasExactKeys(v, ['kind', 'payload']) && v.kind === 'resourceRegister' && isResourceRegisterPayload(v.payload),
    'fleet.nodes.upsert': (v) => hasExactKeys(v, ['kind', 'payload']) && v.kind === 'nodeUpsert' && isTopologyUpsertPayload(v.payload, ['id', 'health']) && isIdentifier(v.payload.id) && isOneOf(v.payload.health, ['unknown', 'online', 'offline', 'disabled', 'error']),
    'fleet.agents.upsert': (v) => hasExactKeys(v, ['kind', 'payload']) && v.kind === 'agentUpsert' && isTopologyUpsertPayload(v.payload, ['id', 'nodeId']) && isIdentifier(v.payload.id) && isIdentifier(v.payload.nodeId),
    'fleet.agents.revoke': (v) => hasExactKeys(v, ['kind', 'payload']) && v.kind === 'agentRevoke' && isIdPayload(v.payload),
    'fleet.capabilities.sync.begin': (v) => isPayload(v, ['kind', 'payload']) && v.kind === 'capabilitySyncBegin' && isCommandIdPayload(v.payload),
    'fleet.capabilities.sync.complete': (v) => isPayload(v, ['kind', 'payload']) && v.kind === 'capabilitySyncComplete' && isCapabilitySyncPayload(v.payload),
    'fleet.runtimes.upsert': (v) => hasExactKeys(v, ['kind', 'payload']) && v.kind === 'runtimeUpsert' && isTopologyUpsertPayload(v.payload, ['id', 'nodeId', 'agentId', 'kind', 'state']) && isIdentifier(v.payload.id) && isIdentifier(v.payload.nodeId) && (v.payload.agentId === null || isIdentifier(v.payload.agentId)) && isOneOf(v.payload.kind, ['openClaw', 'matchaAgent', 'plugin']) && isOneOf(v.payload.state, ['discovered', 'running', 'stopped', 'degraded', 'retired']),
    'fleet.endpoints.upsert': (v) => hasExactKeys(v, ['kind', 'payload']) && v.kind === 'endpointUpsert' && isTopologyUpsertPayload(v.payload, ['id', 'nodeId', 'runtimeId', 'health']) && isIdentifier(v.payload.id) && isIdentifier(v.payload.nodeId) && isIdentifier(v.payload.runtimeId) && isOneOf(v.payload.health, ['unknown', 'ready', 'busy', 'draining', 'unhealthy', 'retired']),
    'fleet.connections.probe.begin': (v) => isPayload(v, ['kind', 'payload']) && v.kind === 'connectionProbeBegin' && isCommandIdPayload(v.payload),
    'fleet.connections.probe.complete': (v) => isPayload(v, ['kind', 'payload']) && v.kind === 'connectionProbeComplete' && isConnectionProbeCompletePayload(v.payload),
    'fleet.environments.deploy.begin': (v) => isPayload(v, ['kind', 'payload']) && v.kind === 'environmentDeployBegin' && isPhasePayload(v.payload),
    'fleet.environments.deploy.complete': (v) => isPayload(v, ['kind', 'payload']) && v.kind === 'environmentDeployComplete' && isPhasePayload(v.payload),
    'fleet.environments.deploy.fail': (v) => isPayload(v, ['kind', 'payload']) && v.kind === 'environmentDeployFail' && isFailurePayload(v.payload),
    'fleet.environments.delete.begin': (v) => isPayload(v, ['kind', 'payload']) && v.kind === 'environmentDeleteBegin' && isPhasePayload(v.payload),
    'fleet.environments.delete.complete': (v) => isPayload(v, ['kind', 'payload']) && v.kind === 'environmentDeleteComplete' && isPhasePayload(v.payload),
    'fleet.environments.delete.fail': (v) => isPayload(v, ['kind', 'payload']) && v.kind === 'environmentDeleteFail' && isFailurePayload(v.payload),
    'fleet.resources.provision.begin': (v) => isPayload(v, ['kind', 'payload']) && v.kind === 'resourceProvisionBegin' && isPhasePayload(v.payload),
    'fleet.resources.provision.complete': (v) => isPayload(v, ['kind', 'payload']) && v.kind === 'resourceProvisionComplete' && isPhasePayload(v.payload),
    'fleet.resources.delete.begin': (v) => isPayload(v, ['kind', 'payload']) && v.kind === 'resourceDeleteBegin' && isPhasePayload(v.payload),
    'fleet.resources.delete.complete': (v) => isPayload(v, ['kind', 'payload']) && v.kind === 'resourceDeleteComplete' && isPhasePayload(v.payload),
    'fleet.resources.delete.fail': (v) => isPayload(v, ['kind', 'payload']) && v.kind === 'resourceDeleteFail' && isFailurePayload(v.payload),
    'fleet.nodes.retire': (v) => isPayload(v, ['kind', 'payload']) && v.kind === 'nodeRetire' && isIdPayload(v.payload),
    'fleet.runtimes.start.begin': (v) => isPayload(v, ['kind', 'payload']) && v.kind === 'runtimeStartBegin' && isCommandIdPayload(v.payload),
    'fleet.runtimes.start.complete': (v) => isPayload(v, ['kind', 'payload']) && v.kind === 'runtimeStartComplete' && isCommandIdPayload(v.payload),
    'fleet.runtimes.stop.begin': (v) => isPayload(v, ['kind', 'payload']) && v.kind === 'runtimeStopBegin' && isCommandIdPayload(v.payload),
    'fleet.runtimes.stop.complete': (v) => isPayload(v, ['kind', 'payload']) && v.kind === 'runtimeStopComplete' && isCommandIdPayload(v.payload),
    'fleet.runtimes.retire': (v) => isPayload(v, ['kind', 'payload']) && v.kind === 'runtimeRetire' && isIdPayload(v.payload),
    'fleet.endpoints.drain': (v) => isPayload(v, ['kind', 'payload']) && v.kind === 'endpointDrain' && isIdPayload(v.payload),
    'fleet.endpoints.retire': (v) => isPayload(v, ['kind', 'payload']) && v.kind === 'endpointRetire' && isIdPayload(v.payload),
    'fleet.endpoints.probe.begin': (v) => isPayload(v, ['kind', 'payload']) && v.kind === 'endpointProbeBegin' && isCommandIdPayload(v.payload),
    'fleet.terminals.open': (v) => isPayload(v, ['kind', 'payload']) && v.kind === 'terminalOpen' && isTerminalOpenPayload(v.payload),
    'fleet.terminals.reconnect': (v) => isPayload(v, ['kind', 'payload']) && v.kind === 'terminalReconnect' && isTerminalSessionPayload(v.payload),
    'fleet.terminals.close.begin': (v) => isPayload(v, ['kind', 'payload']) && v.kind === 'terminalBeginClose' && isTerminalSessionPayload(v.payload),
    'fleet.terminals.close.complete': (v) => isPayload(v, ['kind', 'payload']) && v.kind === 'terminalFinishClose' && isTerminalSessionPayload(v.payload),
    'fleet.terminals.close': (v) => isPayload(v, ['kind', 'payload']) && v.kind === 'terminalClose' && isTerminalSessionPayload(v.payload),
  };
  return validators[value.operation](input);
}

function isConnectionProbeCompletePayload(value: unknown): boolean { return isPayload(value, ['id', 'commandId', 'outcome', 'message']) && isIdentifier(value.id) && isIdentifier(value.commandId) && isOneOf(value.outcome, ['ready', 'unhealthy']) && (value.message === null || isText(value.message)); }
function isTerminalOpenPayload(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, ['nodeId', 'runtimeId', 'endpointId', 'size'])) {
    return false;
  }
  if (value.nodeId !== undefined && !isIdentifier(value.nodeId)) return false;
  if (value.runtimeId !== undefined && !isIdentifier(value.runtimeId)) return false;
  if (value.endpointId !== undefined && !isIdentifier(value.endpointId)) return false;
  const selectorCount = [value.nodeId, value.runtimeId, value.endpointId].filter(isIdentifier).length;
  return selectorCount === 1 && (value.size === undefined || isTerminalSize(value.size));
}

function isTerminalSize(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['rows', 'cols'])
    && isTerminalDimension(value.rows)
    && isTerminalDimension(value.cols);
}
function isTerminalSessionPayload(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['sessionId'])
    && isIdentifier(value.sessionId);
}
function isTerminalDimension(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 1000;
}
function isIdPayload(value: unknown): boolean { return isPayload(value, ['id']) && isIdentifier(value.id); }
function isCommandIdPayload(value: unknown): boolean { return isPayload(value, ['id', 'commandId']) && isIdentifier(value.id) && isIdentifier(value.commandId); }
function isCapabilitySyncPayload(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ['id', 'commandId', 'capabilities', 'metadata']) || !isIdentifier(value.id) || !isIdentifier(value.commandId) || !Array.isArray(value.capabilities) || !isRecord(value.metadata) || !hasExactKeys(value.metadata, ['source', 'observedAt', 'freshness']) || !isOneOf(value.metadata.source, ['discovery', 'healthProbe', 'runtimeAgent']) || !isText(value.metadata.observedAt) || !isOneOf(value.metadata.freshness, ['current', 'stale', 'unknown', 'pruned'])) return false;
  return value.capabilities.every((item) => isRecord(item) && hasExactKeys(item, ['id', 'scope', 'availability']) && isIdentifier(item.id) && isOneOf(item.scope, ['endpoint', 'agent', 'session']) && isOneOf(item.availability, ['available', 'unavailable', 'unknown']));
}
function isPhasePayload(value: unknown): boolean { return isPayload(value, ['id', 'commandId', 'phase']) && isIdentifier(value.id) && isIdentifier(value.commandId) && isIdentifier(value.phase); }
function isFailurePayload(value: unknown): boolean { return isPayload(value, ['id', 'commandId', 'phase', 'message']) && isIdentifier(value.id) && isIdentifier(value.commandId) && isIdentifier(value.phase) && isText(value.message); }
function isConnectionUpsertPayload(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ['id', 'kind', 'displayName', 'endpoint', 'labels', 'enabled', 'publicConfig', 'secretRefs'])) return false;
  return isIdentifier(value.id) && isOneOf(value.kind, ['sshHost', 'container', 'vm', 'kubernetesPod', 'custom'])
    && isText(value.displayName) && (value.endpoint === null || isText(value.endpoint))
    && Array.isArray(value.labels) && value.labels.every(isText) && typeof value.enabled === 'boolean'
    && isConnectionPublicConfig(value.kind, value.publicConfig) && isSecretRefs(value.secretRefs);
}

function isConnectionPublicConfig(kind: unknown, value: unknown): boolean {
  const keys = kind === 'sshHost'
    ? ['host', 'port', 'username', 'authKind']
    : kind === 'container'
      ? ['endpointUrl', 'containerName', 'image', 'connectionSource', 'authMethod']
      : kind === 'kubernetesPod'
        ? ['apiServerUrl', 'namespace', 'deploymentName', 'serviceName', 'image']
        : kind === 'vm'
          ? ['host', 'port', 'username', 'loginMethod']
          : ['endpointUrl'];
  return isRecord(value) && Object.keys(value).every((key) => keys.includes(key))
    && Object.values(value).every((item) => isText(item));
}

function isSecretRefs(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).every(isIdentifier)
    && Object.values(value).every(isSecretRef);
}
function isEnvironmentRegisterPayload(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['id', 'connectionId', 'kind', 'displayName', 'labels', 'enabled', 'publicConfig', 'secretRefs'])
    && isIdentifier(value.id)
    && isIdentifier(value.connectionId)
    && isOneOf(value.kind, ['sshWorkdir', 'dockerContainer', 'kubernetesWorkload', 'vmWorkdir', 'custom'])
    && isText(value.displayName)
    && Array.isArray(value.labels)
    && value.labels.every(isText)
    && typeof value.enabled === 'boolean'
    && isRecord(value.publicConfig)
    && Object.values(value.publicConfig).every(isText)
    && isSecretRefs(value.secretRefs);
}
function isResourceRegisterPayload(value: unknown): boolean {
  return isPayload(value, ['id', 'connectionId', 'environmentId', 'provider', 'kind', 'remoteResourceId', 'ownership', 'cleanupPolicy']) && isIdentifier(value.id) && isIdentifier(value.connectionId) && isIdentifier(value.environmentId) && isIdentifier(value.remoteResourceId) && isOneOf(value.provider, ['docker', 'kubernetes', 'ssh', 'vm', 'custom']) && isOneOf(value.kind, ['dockerContainer', 'kubernetesWorkload', 'kubernetesDeployment', 'kubernetesService', 'kubernetesSecret', 'sshAgentInstallation', 'vmAgentInstallation', 'custom']) && isOneOf(value.ownership, ['matchaManaged', 'unverified', 'external']) && isOneOf(value.cleanupPolicy, ['deleteOnEnvironmentDelete', 'uninstallAgentOnly', 'orphan', 'none']);
}

function isMutationOperation(value: string): value is FleetMutationOperation {
  return ['fleet.targets.put', 'fleet.targets.remove', 'fleet.commands.submit', 'fleet.commands.submit.node', 'fleet.commands.begin', 'fleet.commands.accept', 'fleet.commands.reject', 'fleet.commands.unknown', 'fleet.commands.replay', 'fleet.connections.upsert', 'fleet.connections.remove', 'fleet.connections.probe.begin', 'fleet.connections.probe.complete', 'fleet.environments.register', 'fleet.environments.deploy.begin', 'fleet.environments.deploy.complete', 'fleet.environments.deploy.fail', 'fleet.environments.delete.begin', 'fleet.environments.delete.complete', 'fleet.environments.delete.fail', 'fleet.resources.register', 'fleet.resources.provision.begin', 'fleet.resources.provision.complete', 'fleet.resources.delete.begin', 'fleet.resources.delete.complete', 'fleet.resources.delete.fail', 'fleet.nodes.upsert', 'fleet.nodes.retire', 'fleet.agents.upsert', 'fleet.agents.revoke', 'fleet.capabilities.sync.begin', 'fleet.capabilities.sync.complete', 'fleet.terminals.open', 'fleet.terminals.reconnect', 'fleet.terminals.close.begin', 'fleet.terminals.close.complete', 'fleet.terminals.close', 'fleet.runtimes.upsert', 'fleet.runtimes.start.begin', 'fleet.runtimes.start.complete', 'fleet.runtimes.stop.begin', 'fleet.runtimes.stop.complete', 'fleet.runtimes.retire', 'fleet.endpoints.upsert', 'fleet.endpoints.drain', 'fleet.endpoints.retire', 'fleet.endpoints.probe.begin'].includes(value);
}

function isFleetMutationResponse(
  value: unknown,
  operation: FleetMutationOperation,
): value is FleetMutationResult | FleetTerminalCloseResult | FleetTerminalSessionResult {
  if (operation === 'fleet.terminals.open') return isTerminalSessionResponse(value, 'terminalOpened');
  if (operation === 'fleet.terminals.reconnect') return isTerminalSessionResponse(value, 'terminalReconnected');
  return operation === 'fleet.terminals.close'
    ? isTerminalCloseResponse(value)
    : isMutationResponse(value);
}

function isTerminalCloseResponse(value: unknown): value is FleetTerminalCloseResult {
  return isRecord(value)
    && hasExactKeys(value, ['outcome'])
    && (value.outcome === 'terminalClosed' || value.outcome === 'error');
}

function isTerminalSessionResponse(
  value: unknown,
  outcome: FleetMutationOutcome,
): value is FleetTerminalSessionResult {
  if (!isRecord(value)
    || !hasExactKeys(value, ['outcome', 'session', 'terminalConnection'])
    || value.outcome !== outcome
    || !isTerminalSessionSummary(value.session)
    || !isTerminalConnection(value.terminalConnection)) {
    return false;
  }
  return value.session.id === value.terminalConnection.sessionId;
}

function isTerminalSessionSummary(value: unknown): value is FleetTerminalSessionSummary {
  if (!isRecord(value)
    || !hasRequiredKeys(value, ['id', 'nodeId', 'status', 'createdAt', 'updatedAt', 'expiresAt'])
    || !hasOnlyKeys(value, ['id', 'nodeId', 'runtimeId', 'endpointId', 'targetKind', 'status', 'createdAt', 'updatedAt', 'expiresAt', 'reason'])
    || !isIdentifier(value.id)
    || !isIdentifier(value.nodeId)
    || !isOneOf(value.status, ['opening', 'connected', 'closing', 'closed', 'failed', 'expired'])
    || !isTimestamp(value.createdAt)
    || !isTimestamp(value.updatedAt)
    || !isTimestamp(value.expiresAt)) {
    return false;
  }
  return (value.runtimeId === undefined || isIdentifier(value.runtimeId))
    && (value.endpointId === undefined || isIdentifier(value.endpointId))
    && (value.targetKind === undefined || isOneOf(value.targetKind, ['ssh-host', 'container', 'vm', 'k8s-pod', 'custom']))
    && (value.reason === undefined || isText(value.reason));
}

function isTerminalConnection(value: unknown): value is FleetTerminalConnection {
  return isRecord(value)
    && hasExactKeys(value, ['sessionId', 'ticket', 'websocketPath', 'expiresAt'])
    && isIdentifier(value.sessionId)
    && isBase64Url(value.ticket)
    && value.websocketPath === PUBLIC_FLEET_TERMINAL_STREAM_PATH
    && isTimestamp(value.expiresAt);
}

function isBase64Url(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 4096
    && /^[A-Za-z0-9_-]+$/.test(value);
}

function isMutationResponse(value: unknown): value is FleetMutationResult {
  if (!isRecord(value) || !['submitted', 'alreadySubmitted', 'completed', 'rejected', 'accepted', 'outcomeUnknown', 'alreadyRecorded', 'replayed', 'replayAuthorized', 'targetUpdated', 'targetRemoved', 'connectionUpdated', 'connectionRemoved', 'environmentRegistered', 'resourceRegistered', 'nodeUpdated', 'nodeRetired', 'agentUpdated', 'agentRevoked', 'runtimeUpdated', 'runtimeLifecycleUpdated', 'runtimeRetired', 'endpointUpdated', 'endpointDrained', 'endpointRetired', 'probeStarted', 'probeCompleted', 'probeUnknown', 'probeRejected', 'capabilitySyncStarted', 'capabilitySyncCompleted', 'deploymentCompleted', 'deploymentFailed', 'deploymentUnknown', 'deletionCompleted', 'deletionFailed', 'deletionUnknown', 'provisioningCompleted', 'provisioningFailed', 'provisioningUnknown', 'terminalOpened', 'terminalReconnected', 'terminalClosing', 'terminalClosed'].includes(String(value.outcome))) return false;
  const allowed = ['outcome', 'commandId', 'dispatchId', 'attempt', 'target'] as const;
  if (!Object.keys(value).every((key) => allowed.includes(key as typeof allowed[number]))) return false;
  if (typeof value.commandId !== 'undefined' && !isIdentifier(value.commandId)) return false;
  if (typeof value.dispatchId !== 'undefined' && !isIdentifier(value.dispatchId)) return false;
  if (typeof value.attempt !== 'undefined' && !isPositiveCounter(value.attempt)) return false;
  return typeof value.target === 'undefined' || isTarget(value.target);
}

function isSecretRef(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('remote-fleet://') || value.length > 271
    || value.includes('..')) return false;
  const path = value.slice('remote-fleet://'.length);
  return path.length > 0 && !path.includes('//')
    && path.split('/').every((part) => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(part));
}

function isReceiptInput(value: Record<string, unknown>, kind: string): boolean {
  return hasExactKeys(value, ['kind', 'payload']) && value.kind === kind
    && isPayload(value.payload, ['dispatchId', 'attempt']) && isIdentifier(value.payload.dispatchId)
    && isPositiveCounter(value.payload.attempt);
}

function isTopologyUpsertPayload(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value) || !hasExactKeys(value, [...keys, 'connectionId', 'environmentId', 'managedResourceId'])) return false;
  return [value.connectionId, value.environmentId, value.managedResourceId].every((item) => item === null || isIdentifier(item));
}

function isPayload(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && hasExactKeys(value, keys);
}

function isTargetPutPayload(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['id', 'target']) && isIdentifier(value.id) && isTargetConfig(value.target);
}

function isTargetConfig(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'docker') return hasRequiredKeys(value, ['kind', 'endpoint', 'containerName', 'image']) && hasOnlyKeys(value, ['kind', 'endpoint', 'containerName', 'image', 'secretRef']) && isOrigin(value.endpoint, false) && isText(value.containerName) && isText(value.image) && isOptionalSecretRef(value.secretRef);
  if (value.kind === 'kubernetes') return hasExactKeys(value, ['kind', 'apiServer', 'namespace', 'deploymentName', 'serviceName', 'image', 'secretRef']) && isOrigin(value.apiServer, true) && isDnsLabel(value.namespace) && isDnsLabel(value.deploymentName) && isDnsLabel(value.serviceName) && isText(value.image) && isSecretRef(value.secretRef);
  if (value.kind === 'ssh') return hasRequiredKeys(value, ['kind', 'host', 'authKind', 'secretRef', 'installCommand']) && hasOnlyKeys(value, ['kind', 'host', 'port', 'username', 'authKind', 'secretRef', 'installCommand']) && isText(value.host) && (value.port === undefined || isPort(value.port)) && (value.username === undefined || isText(value.username)) && isOneOf(value.authKind, ['privateKey', 'password']) && isSecretRef(value.secretRef) && isText(value.installCommand);
  return value.kind === 'custom' && hasRequiredKeys(value, ['kind', 'endpoint']) && hasOnlyKeys(value, ['kind', 'endpoint', 'secretRef']) && isWebsocket(value.endpoint) && isOptionalSecretRef(value.secretRef);
}

function isOptionalSecretRef(value: unknown): boolean { return value === undefined || isSecretRef(value); }
function hasRequiredKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return keys.every((key) => Object.hasOwn(value, key)); }
function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).every((key) => keys.includes(key)); }

function isCommandSubmitPayload(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ['commandId', 'idempotencyKey', 'agentId', 'target', 'kind', 'dispatchId', 'selector'])) return false;
  return isIdentifier(value.commandId) && isIdentifier(value.idempotencyKey) && isIdentifier(value.agentId)
    && isCommandTarget(value.target) && isCommandKind(value.kind) && isIdentifier(value.dispatchId)
    && isRecord(value.selector) && hasExactKeys(value.selector, ['targetId', 'revision', 'expectedKind'])
    && isIdentifier(value.selector.targetId) && isCounter(value.selector.revision)
    && isOneOf(value.selector.expectedKind, ['docker', 'kubernetes', 'ssh', 'custom']);
}

function isNodeCommandSubmitPayload(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['nodeId', 'commandId', 'idempotencyKey', 'dispatchId', 'kind'])
    && isIdentifier(value.nodeId)
    && isIdentifier(value.commandId)
    && isIdentifier(value.idempotencyKey)
    && isIdentifier(value.dispatchId)
    && (value.kind === 'probeNode' || value.kind === 'installAgent');
}

function isCommandKind(value: unknown): boolean {
  return isOneOf(value, ['probeNode', 'installAgent', 'startRuntime', 'stopRuntime', 'syncCapabilities', 'upgradeAgent', 'mountWorkspace', 'exposePort']);
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 16 * 1024
    && [...value].every((character) => character >= ' ' && character !== '');
}

function isOrigin(value: unknown, httpsOnly: boolean): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (httpsOnly ? url.protocol === 'https:' : ['http:', 'https:'].includes(url.protocol))
      && !!url.hostname && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
  } catch { return false; }
}

function isWebsocket(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return ['ws:', 'wss:'].includes(url.protocol)
      && !!url.hostname
      && !url.username
      && !url.password
      && !url.search
      && !url.hash;
  } catch { return false; }
}

function isDnsLabel(value: unknown): boolean { return typeof value === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value); }
function isPort(value: unknown): boolean { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 65535; }
function isPositiveCounter(value: unknown): value is number { return isCounter(value) && value > 0; }

function isSuccessResponse(value: unknown, operation: FleetReadOperation): value is FleetSuccessBody {
  switch (operation) {
    case 'fleet.targets.list': return isTargetsResponse(value);
    case 'fleet.snapshot.get': return isFleetSnapshot(value);
    case 'fleet.topology.get': return isTopologyResponse(value);
    case 'fleet.connections.list': return isConnectionsResponse(value);
    case 'fleet.capabilities.list': return isCapabilitiesResponse(value);
    case 'fleet.environments.list': return isEnvironmentsResponse(value);
    case 'fleet.resources.list': return isResourcesResponse(value);
    case 'fleet.commands.list': return isCommandsResponse(value);
    case 'fleet.terminals.list': return isTerminalSessionsResponse(value);
    case 'fleet.audit.list': return isAuditResponse(value);
    case 'fleet.leases.list': return isLeasesResponse(value);
    case 'fleet.metrics.get': return isMetricsResponse(value);
    case 'fleet.selector.preview': return isSelectorPreviewResponse(value);
  }
}

function isFleetSnapshot(value: unknown): value is FleetSnapshot {
  return isRecord(value)
    && hasExactKeys(value, [
      'connections', 'environments', 'managedResources', 'nodes', 'agents', 'runtimes',
      'endpoints', 'capabilities', 'commands', 'leases', 'sessions', 'auditEvents', 'updatedAt',
    ])
    && Array.isArray(value.connections) && value.connections.every(isFleetSnapshotConnection)
    && Array.isArray(value.environments) && value.environments.every(isFleetSnapshotEnvironment)
    && Array.isArray(value.managedResources) && value.managedResources.every(isFleetSnapshotManagedResource)
    && Array.isArray(value.nodes) && value.nodes.every(isFleetSnapshotNode)
    && Array.isArray(value.agents) && value.agents.every(isFleetSnapshotAgent)
    && Array.isArray(value.runtimes) && value.runtimes.every(isFleetSnapshotRuntime)
    && Array.isArray(value.endpoints) && value.endpoints.every(isFleetSnapshotEndpoint)
    && Array.isArray(value.capabilities) && value.capabilities.every(isFleetSnapshotCapability)
    && Array.isArray(value.commands) && value.commands.every(isFleetSnapshotCommand)
    && Array.isArray(value.leases) && value.leases.every(isFleetSnapshotLease)
    && Array.isArray(value.sessions) && value.sessions.every(isFleetSnapshotSession)
    && Array.isArray(value.auditEvents) && value.auditEvents.every(isFleetSnapshotAuditEvent)
    && isTimestamp(value.updatedAt);
}

function isFleetSnapshotConnection(value: unknown): value is FleetSnapshotConnection {
  return isRecord(value)
    && hasExactKeys(value, ['id', 'displayName', 'connectionKind', 'status', 'labels', 'enabled', 'createdAt', 'updatedAt'])
    && isIdentifier(value.id) && isText(value.displayName)
    && isOneOf(value.connectionKind, ['ssh-host', 'container', 'vm', 'k8s-pod', 'custom'])
    && isOneOf(value.status, ['unknown', 'online', 'offline', 'disabled', 'error'])
    && isTextArray(value.labels) && typeof value.enabled === 'boolean'
    && isTimestamp(value.createdAt) && isTimestamp(value.updatedAt);
}

function isFleetSnapshotEnvironment(value: unknown): value is FleetSnapshotEnvironment {
  return isRecord(value)
    && hasExactKeys(value, ['id', 'connectionId', 'displayName', 'environmentKind', 'status', 'labels', 'enabled', 'createdAt', 'updatedAt'])
    && isIdentifier(value.id) && isIdentifier(value.connectionId) && isText(value.displayName)
    && isOneOf(value.environmentKind, ['ssh-workdir', 'docker-container', 'k8s-workload', 'vm-workdir', 'custom'])
    && isOneOf(value.status, ['registered', 'deploying', 'ready', 'deleting', 'deleted', 'orphaned', 'failed'])
    && isTextArray(value.labels) && typeof value.enabled === 'boolean'
    && isTimestamp(value.createdAt) && isTimestamp(value.updatedAt);
}

function isFleetSnapshotManagedResource(value: unknown): value is FleetSnapshotManagedResource {
  return isRecord(value)
    && hasExactKeys(value, [
      'id', 'connectionId', 'environmentId', 'providerKind', 'resourceKind', 'remoteResourceId',
      'status', 'ownership', 'cleanupPolicy', 'createdAt', 'updatedAt',
    ])
    && isIdentifier(value.id) && isIdentifier(value.connectionId) && isIdentifier(value.environmentId)
    && isOneOf(value.providerKind, ['docker', 'k8s', 'ssh', 'vm', 'custom'])
    && isOneOf(value.resourceKind, [
      'docker-container', 'k8s-workload', 'k8s-deployment', 'k8s-service', 'k8s-secret',
      'ssh-agent-installation', 'vm-agent-installation', 'custom',
    ])
    && isText(value.remoteResourceId)
    && isOneOf(value.status, ['observed', 'provisioning', 'ready', 'deleting', 'deleted', 'conflict', 'failed'])
    && isOneOf(value.ownership, ['matchaManaged', 'unverified', 'external'])
    && isOneOf(value.cleanupPolicy, ['deleteOnEnvironmentDelete', 'uninstallAgentOnly', 'orphan', 'none'])
    && isTimestamp(value.createdAt) && isTimestamp(value.updatedAt);
}

function isFleetSnapshotNode(value: unknown): value is FleetSnapshotNode {
  return isRecord(value)
    && hasExactKeys(value, ['id', 'connectionId', 'environmentId', 'managedResourceId', 'status', 'lastSeenAt'])
    && isIdentifier(value.id) && isNullableIdentifier(value.connectionId)
    && isNullableIdentifier(value.environmentId) && isNullableIdentifier(value.managedResourceId)
    && isOneOf(value.status, ['unknown', 'online', 'offline', 'disabled', 'error'])
    && isTimestamp(value.lastSeenAt);
}

function isFleetSnapshotAgent(value: unknown): value is FleetSnapshotAgent {
  return isRecord(value)
    && hasExactKeys(value, ['id', 'connectionId', 'environmentId', 'managedResourceId', 'nodeId'])
    && isIdentifier(value.id) && isNullableIdentifier(value.connectionId)
    && isNullableIdentifier(value.environmentId) && isNullableIdentifier(value.managedResourceId)
    && isIdentifier(value.nodeId);
}

function isFleetSnapshotRuntime(value: unknown): value is FleetSnapshotRuntime {
  return isRecord(value)
    && hasExactKeys(value, [
      'id', 'connectionId', 'environmentId', 'managedResourceId', 'nodeId', 'agentId', 'status', 'startedAt',
    ])
    && isIdentifier(value.id) && isNullableIdentifier(value.connectionId)
    && isNullableIdentifier(value.environmentId) && isNullableIdentifier(value.managedResourceId)
    && isIdentifier(value.nodeId) && isNullableIdentifier(value.agentId)
    && isOneOf(value.status, ['unknown', 'running', 'stopped', 'error'])
    && (value.status === 'running' ? isTimestamp(value.startedAt) : value.startedAt === null);
}

function isFleetSnapshotEndpoint(value: unknown): value is FleetSnapshotEndpoint {
  return isRecord(value)
    && hasExactKeys(value, [
      'id', 'connectionId', 'environmentId', 'managedResourceId', 'nodeId', 'runtimeId', 'status', 'lastProbeAt',
    ])
    && isIdentifier(value.id) && isNullableIdentifier(value.connectionId)
    && isNullableIdentifier(value.environmentId) && isNullableIdentifier(value.managedResourceId)
    && isIdentifier(value.nodeId) && isIdentifier(value.runtimeId)
    && isOneOf(value.status, ['unknown', 'ready', 'busy', 'draining', 'unhealthy', 'retired'])
    && isTimestamp(value.lastProbeAt);
}

function isFleetSnapshotCapability(value: unknown): value is FleetSnapshotCapability {
  return isRecord(value)
    && hasExactKeys(value, ['id', 'endpointId', 'nodeId', 'runtimeId', 'status'])
    && isIdentifier(value.id) && isIdentifier(value.endpointId) && isIdentifier(value.nodeId)
    && isIdentifier(value.runtimeId)
    && isOneOf(value.status, ['current', 'unavailable', 'unknown', 'stale']);
}

function isFleetSnapshotCommand(value: unknown): value is FleetSnapshotCommand {
  if (!isRecord(value)
    || !isIdentifier(value.id)
    || !isOneOf(value.command, ['probeNode', 'installAgent', 'startRuntime', 'stopRuntime', 'syncCapabilities', 'upgradeAgent', 'mountWorkspace', 'exposePort'])
    || !isOneOf(value.status, ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'timed-out', 'unknown'])
    || !isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt)) return false;
  if (typeof value.nodeId !== 'string' || !isIdentifier(value.nodeId)) return false;
  if (Object.hasOwn(value, 'endpointId')) {
    return hasExactKeys(value, ['id', 'command', 'status', 'createdAt', 'updatedAt', 'nodeId', 'runtimeId', 'endpointId'])
      && isIdentifier(value.runtimeId) && isIdentifier(value.endpointId);
  }
  if (Object.hasOwn(value, 'runtimeId')) {
    return hasExactKeys(value, ['id', 'command', 'status', 'createdAt', 'updatedAt', 'nodeId', 'runtimeId'])
      && isIdentifier(value.runtimeId);
  }
  return hasExactKeys(value, ['id', 'command', 'status', 'createdAt', 'updatedAt', 'nodeId']);
}

function isFleetSnapshotLease(value: unknown): value is FleetSnapshotLease {
  return isRecord(value)
    && hasExactKeys(value, ['id', 'endpointId', 'ownerKind', 'ownerId', 'status', 'expiresAt'])
    && isIdentifier(value.id) && isIdentifier(value.endpointId)
    && isOneOf(value.ownerKind, ['manualOperation', 'runtimeStart', 'session', 'teamRun'])
    && isText(value.ownerId) && isOneOf(value.status, ['active', 'released', 'expired'])
    && (value.status === 'active' ? isTimestamp(value.expiresAt) : value.expiresAt === null);
}

function isFleetSnapshotSession(value: unknown): value is FleetSnapshotSession {
  return isRecord(value)
    && hasExactKeys(value, ['id', 'nodeId', 'status', 'createdAt', 'updatedAt', 'expiresAt'])
    && isIdentifier(value.id) && isIdentifier(value.nodeId)
    && isOneOf(value.status, ['opening', 'connected', 'closing', 'closed', 'failed', 'expired'])
    && isTimestamp(value.createdAt) && isTimestamp(value.updatedAt) && isTimestamp(value.expiresAt);
}

function isFleetSnapshotAuditEvent(value: unknown): value is FleetSnapshotAuditEvent {
  return isRecord(value)
    && hasExactKeys(value, [
      'id', 'eventName', 'occurredAt', 'connectionId', 'environmentId', 'managedResourceId',
      'nodeId', 'agentId', 'runtimeId', 'endpointId', 'commandId',
    ])
    && typeof value.id === 'string' && value.id.length <= 4096 && /^audit:[0-9]+$/.test(value.id)
    && isText(value.eventName) && isTimestamp(value.occurredAt)
    && isNullableIdentifier(value.connectionId) && isNullableIdentifier(value.environmentId)
    && isNullableIdentifier(value.managedResourceId) && isNullableIdentifier(value.nodeId)
    && isNullableIdentifier(value.agentId) && isNullableIdentifier(value.runtimeId)
    && isNullableIdentifier(value.endpointId) && isNullableIdentifier(value.commandId);
}

function isTextArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isText);
}

function isNullableIdentifier(value: unknown): value is string | null {
  return value === null || isIdentifier(value);
}

function isSelectorPreviewResponse(value: unknown): value is FleetSelectorPreview {
  if (!isRecord(value) || !hasExactKeys(value, ['constraints', 'candidates', 'exclusions', 'unavailableConstraints'])
    || !isSelectorConstraints(value.constraints) || !Array.isArray(value.candidates) || !Array.isArray(value.exclusions)
    || !Array.isArray(value.unavailableConstraints)) return false;
  return value.candidates.every(isSelectorCandidate)
    && value.exclusions.every(isSelectorExclusion)
    && value.unavailableConstraints.every((item) => isOneOf(item, ['endpointIds', 'nodeIds', 'runtimeIds', 'labels', 'operationIds']));
}
function isSelectorConstraints(value: unknown): value is FleetSelectorConstraints {
  return isRecord(value) && hasExactKeys(value, ['endpointIds', 'nodeIds', 'runtimeIds', 'labels', 'operationIds'])
    && [value.endpointIds, value.nodeIds, value.runtimeIds, value.labels, value.operationIds].every((items) => Array.isArray(items) && items.every(isIdentifier));
}
function isSelectorCandidate(value: unknown): value is FleetSelectorCandidate {
  return isRecord(value) && hasExactKeys(value, ['endpointId', 'nodeId', 'runtimeId', 'health', 'activeLeaseCount', 'capabilities'])
    && isIdentifier(value.endpointId) && isIdentifier(value.nodeId) && isIdentifier(value.runtimeId)
    && isOneOf(value.health, ['unknown', 'ready', 'busy', 'draining', 'unhealthy', 'retired']) && isCounter(value.activeLeaseCount)
    && Array.isArray(value.capabilities) && value.capabilities.every((item) => isRecord(item) && hasExactKeys(item, ['id', 'availability']) && isIdentifier(item.id) && isOneOf(item.availability, ['available', 'unavailable', 'unknown']));
}
function isSelectorExclusion(value: unknown): value is FleetSelectorExclusion {
  return isRecord(value) && hasExactKeys(value, ['endpointId', 'nodeId', 'runtimeId', 'reasons'])
    && isIdentifier(value.endpointId) && isIdentifier(value.nodeId) && isIdentifier(value.runtimeId)
    && Array.isArray(value.reasons) && value.reasons.every(isIdentifier);
}

function isTargetsResponse(value: unknown): value is Readonly<{ targets: readonly FleetTarget[] }> {
  return isRecord(value) && hasExactKeys(value, ['targets']) && Array.isArray(value.targets)
    && value.targets.every(isTarget);
}

function isTopologyResponse(value: unknown): value is Readonly<{
  nodes: readonly FleetNode[];
  agents: readonly FleetAgent[];
  runtimes: readonly FleetRuntime[];
  endpoints: readonly FleetEndpoint[];
}> {
  return isRecord(value) && hasExactKeys(value, ['nodes', 'agents', 'runtimes', 'endpoints'])
    && Array.isArray(value.nodes) && value.nodes.every(isNode)
    && Array.isArray(value.agents) && value.agents.every(isAgent)
    && Array.isArray(value.runtimes) && value.runtimes.every(isRuntime)
    && Array.isArray(value.endpoints) && value.endpoints.every(isEndpoint);
}

function isConnectionsResponse(value: unknown): value is Readonly<{ connections: readonly FleetConnection[] }> {
  return isRecord(value) && hasExactKeys(value, ['connections']) && Array.isArray(value.connections)
    && value.connections.every(isConnection);
}

function isCapabilitiesResponse(value: unknown): value is Readonly<{ capabilities: readonly FleetCapability[] }> {
  return isRecord(value) && hasExactKeys(value, ['capabilities']) && Array.isArray(value.capabilities) && value.capabilities.every(isCapability);
}

function isCapability(value: unknown): value is FleetCapability {
  return isRecord(value) && hasExactKeys(value, ['id', 'scope', 'endpointId', 'nodeId', 'runtimeId', 'availability', 'observedAt', 'source', 'freshness'])
    && isIdentifier(value.id) && isIdentifier(value.endpointId) && isIdentifier(value.nodeId) && isIdentifier(value.runtimeId)
    && isOneOf(value.scope, ['endpoint', 'agent', 'session']) && isOneOf(value.availability, ['available', 'unavailable', 'unknown'])
    && isTimestamp(value.observedAt) && isOneOf(value.source, ['discovery', 'healthProbe', 'runtimeAgent']) && isFreshness(value.freshness);
}

function isEnvironmentsResponse(value: unknown): value is Readonly<{ environments: readonly FleetEnvironment[] }> {
  return isRecord(value) && hasExactKeys(value, ['environments']) && Array.isArray(value.environments)
    && value.environments.every(isEnvironment);
}

function isResourcesResponse(value: unknown): value is Readonly<{ resources: readonly FleetResource[] }> {
  return isRecord(value) && hasExactKeys(value, ['resources']) && Array.isArray(value.resources)
    && value.resources.every(isResource);
}

function isCommandsResponse(value: unknown): value is Readonly<{ commands: readonly FleetCommand[] }> {
  return isRecord(value) && hasExactKeys(value, ['commands']) && Array.isArray(value.commands)
    && value.commands.every(isCommand);
}

function isTerminalSessionsResponse(value: unknown): value is Readonly<{ sessions: readonly FleetTerminalSession[] }> {
  return isRecord(value) && hasExactKeys(value, ['sessions']) && Array.isArray(value.sessions)
    && value.sessions.every(isTerminalSession);
}

function isTerminalSession(value: unknown): value is FleetTerminalSession {
  return isRecord(value) && hasExactKeys(value, ['id', 'targetId', 'provider', 'generation', 'status', 'expiresAt'])
    && isIdentifier(value.id) && isIdentifier(value.targetId) && isIdentifier(value.provider)
    && isCounter(value.generation)
    && isOneOf(value.status, ['Opening', 'Connected', 'Closing', 'Closed', 'Failed', 'Expired'])
    && isTimestamp(value.expiresAt);
}

function isAuditResponse(value: unknown): value is Readonly<{ audit: readonly FleetAudit[] }> {
  return isRecord(value) && hasExactKeys(value, ['audit']) && Array.isArray(value.audit)
    && value.audit.every(isAudit);
}

function isLeasesResponse(value: unknown): value is Readonly<{ leases: readonly FleetLease[] }> {
  return isRecord(value) && hasExactKeys(value, ['leases']) && Array.isArray(value.leases)
    && value.leases.every(isLease);
}

function isLease(value: unknown): value is FleetLease {
  if (!isRecord(value) || !hasExactKeys(value, ['leaseId', 'endpointId', 'owner', 'acquiredAt', 'state'])
    || !isIdentifier(value.leaseId) || !isIdentifier(value.endpointId) || !isTimestamp(value.acquiredAt)
    || !isRecord(value.owner) || !hasExactKeys(value.owner, ['kind', 'id']) || !isOneOf(value.owner.kind, ['manualOperation', 'runtimeStart', 'session', 'teamRun']) || !isIdentifier(value.owner.id)
    || !isRecord(value.state) || typeof value.state.kind !== 'string') return false;
  if (value.state.kind === 'active') return hasExactKeys(value.state, ['kind', 'expiresAt']) && isTimestamp(value.state.expiresAt);
  if (value.state.kind === 'released') return hasExactKeys(value.state, ['kind', 'releasedAt']) && isTimestamp(value.state.releasedAt);
  return value.state.kind === 'expired' && hasExactKeys(value.state, ['kind', 'expiredAt']) && isTimestamp(value.state.expiredAt);
}

function isMetricsResponse(value: unknown): value is Readonly<{ metrics: FleetMetrics }> {
  return isRecord(value) && hasExactKeys(value, ['metrics']) && isMetrics(value.metrics);
}

function isTarget(value: unknown): value is FleetTarget {
  return isRecord(value) && hasExactKeys(value, ['id', 'revision', 'kind'])
    && isIdentifier(value.id) && isCounter(value.revision)
    && isOneOf(value.kind, ['docker', 'kubernetes', 'ssh', 'custom']);
}

function isNode(value: unknown): value is FleetNode {
  return isRecord(value) && hasExactKeys(value, ['id', 'connectionId', 'environmentId', 'managedResourceId', 'health', 'observedAt', 'freshness'])
    && [value.connectionId, value.environmentId, value.managedResourceId].every((item) => item === null || isIdentifier(item))
    && isIdentifier(value.id) && isOneOf(value.health, ['unknown', 'online', 'offline', 'disabled', 'error'])
    && isTimestamp(value.observedAt) && isFreshness(value.freshness);
}

function isAgent(value: unknown): value is FleetAgent {
  return isRecord(value) && hasExactKeys(value, ['id', 'nodeId', 'connectionId', 'environmentId', 'managedResourceId', 'observedAt', 'freshness'])
    && [value.connectionId, value.environmentId, value.managedResourceId].every((item) => item === null || isIdentifier(item))
    && isIdentifier(value.id) && isIdentifier(value.nodeId)
    && isTimestamp(value.observedAt) && isFreshness(value.freshness);
}

function isRuntime(value: unknown): value is FleetRuntime {
  return isRecord(value) && hasExactKeys(value, ['id', 'nodeId', 'agentId', 'connectionId', 'environmentId', 'managedResourceId', 'kind', 'state', 'observedAt', 'freshness'])
    && [value.connectionId, value.environmentId, value.managedResourceId].every((item) => item === null || isIdentifier(item))
    && isIdentifier(value.id) && isIdentifier(value.nodeId) && isIdentifier(value.agentId)
    && isOneOf(value.kind, ['openClaw', 'matchaAgent', 'plugin'])
    && isOneOf(value.state, ['discovered', 'running', 'stopped', 'degraded', 'retired'])
    && isTimestamp(value.observedAt) && isFreshness(value.freshness);
}

function isEndpoint(value: unknown): value is FleetEndpoint {
  return isRecord(value) && hasExactKeys(value, ['id', 'nodeId', 'runtimeId', 'connectionId', 'environmentId', 'managedResourceId', 'health', 'observedAt', 'freshness'])
    && [value.connectionId, value.environmentId, value.managedResourceId].every((item) => item === null || isIdentifier(item))
    && isIdentifier(value.id) && isIdentifier(value.nodeId) && isIdentifier(value.runtimeId)
    && isOneOf(value.health, ['unknown', 'ready', 'busy', 'draining', 'unhealthy', 'retired'])
    && isTimestamp(value.observedAt) && isFreshness(value.freshness);
}

function isConnection(value: unknown): value is FleetConnection {
  return isRecord(value) && hasExactKeys(value, ['id', 'kind', 'displayName', 'endpoint', 'labels', 'publicConfig', 'state', 'enabled', 'createdAt', 'updatedAt'])
    && isIdentifier(value.id) && isOneOf(value.kind, ['sshHost', 'container', 'vm', 'kubernetesPod', 'custom'])
    && isText(value.displayName) && (value.endpoint === null || isText(value.endpoint))
    && Array.isArray(value.labels) && value.labels.every(isText)
    && isRecord(value.publicConfig) && Object.values(value.publicConfig).every(isText)
    && isConnectionState(value.state) && typeof value.enabled === 'boolean'
    && isTimestamp(value.createdAt) && isTimestamp(value.updatedAt);
}

function isEnvironment(value: unknown): value is FleetEnvironment {
  return isRecord(value) && hasExactKeys(value, ['id', 'connectionId', 'displayName', 'kind', 'labels', 'publicConfig', 'state', 'enabled', 'managedResourceCount', 'createdAt', 'updatedAt'])
    && isIdentifier(value.id) && isIdentifier(value.connectionId)
    && isText(value.displayName) && isOneOf(value.kind, ['sshWorkdir', 'dockerContainer', 'kubernetesWorkload', 'vmWorkdir', 'custom'])
    && Array.isArray(value.labels) && value.labels.every(isText)
    && isRecord(value.publicConfig) && Object.values(value.publicConfig).every(isText)
    && isEnvironmentState(value.state) && typeof value.enabled === 'boolean'
    && isCounter(value.managedResourceCount) && isTimestamp(value.createdAt) && isTimestamp(value.updatedAt);
}

function isResource(value: unknown): value is FleetResource {
  return isRecord(value) && hasExactKeys(value, ['id', 'connectionId', 'environmentId', 'provider', 'kind', 'ownership', 'cleanupPolicy', 'state', 'tombstone', 'createdAt', 'updatedAt'])
    && isIdentifier(value.id) && isIdentifier(value.connectionId) && isIdentifier(value.environmentId)
    && isOneOf(value.provider, ['docker', 'kubernetes', 'ssh', 'vm', 'custom'])
    && isOneOf(value.kind, ['dockerContainer', 'kubernetesWorkload', 'kubernetesDeployment', 'kubernetesService', 'kubernetesSecret', 'sshAgentInstallation', 'vmAgentInstallation', 'custom'])
    && isOneOf(value.ownership, ['matchaManaged', 'unverified', 'external'])
    && isOneOf(value.cleanupPolicy, ['deleteOnEnvironmentDelete', 'uninstallAgentOnly', 'orphan', 'none'])
    && isResourceState(value.state) && typeof value.tombstone === 'boolean'
    && isTimestamp(value.createdAt) && isTimestamp(value.updatedAt);
}

function isCommand(value: unknown): value is FleetCommand {
  return isRecord(value) && hasExactKeys(value, ['commandId', 'kind', 'target', 'state', 'createdAt', 'updatedAt'])
    && isIdentifier(value.commandId)
    && isOneOf(value.kind, ['probeNode', 'installAgent', 'startRuntime', 'stopRuntime', 'syncCapabilities', 'upgradeAgent', 'mountWorkspace', 'exposePort'])
    && isCommandTarget(value.target) && isCommandState(value.state) && isTimestamp(value.createdAt) && isTimestamp(value.updatedAt);
}

function isAudit(value: unknown): value is FleetAudit {
  return isRecord(value) && hasExactKeys(value, ['sequence', 'eventName', 'occurredAt', 'actorId', 'connectionId', 'environmentId', 'managedResourceId', 'nodeId', 'agentId', 'runtimeId', 'endpointId', 'commandId'])
    && isCounter(value.sequence) && isIdentifier(value.eventName) && isTimestamp(value.occurredAt)
    && [value.actorId, value.connectionId, value.environmentId, value.managedResourceId, value.nodeId, value.agentId, value.runtimeId, value.endpointId, value.commandId].every((item) => item === null || isIdentifier(item));
}

function isMetrics(value: unknown): value is FleetMetrics {
  return isRecord(value) && hasExactKeys(value, ['nodes', 'agents', 'capabilities', 'runtimes', 'endpoints', 'commands', 'audit', 'leases'])
    && isMetricGroup(value.nodes, ['total', 'unknown', 'online', 'offline', 'disabled', 'error'])
    && isMetricGroup(value.agents, ['total'])
    && isMetricGroup(value.capabilities, ['total', 'available', 'unavailable', 'unknown', 'stale'])
    && isMetricGroup(value.runtimes, ['total', 'discovered', 'running', 'stopped', 'degraded', 'retired'])
    && isEndpointMetrics(value.endpoints)
    && isMetricGroup(value.commands, ['total', 'queued', 'running', 'succeeded', 'failed', 'cancelled', 'timedOut', 'outcomeUnknown'])
    && isAuditMetrics(value.audit)
    && isMetricGroup(value.leases, ['total', 'active', 'released', 'expired', 'manualOperation', 'runtimeStart', 'session', 'teamRun']);
}

function isAuditMetrics(value: unknown): value is FleetMetrics['audit'] {
  return isRecord(value) && hasExactKeys(value, ['total', 'eventCounts']) && isCounter(value.total)
    && isRecord(value.eventCounts) && Object.keys(value.eventCounts).every(isIdentifier) && Object.values(value.eventCounts).every(isCounter);
}

function isEndpointMetrics(value: unknown): value is FleetEndpointMetrics {
  return isRecord(value) && hasExactKeys(value, ['total', 'unknown', 'ready', 'busy', 'draining', 'unhealthy', 'retired', 'drainingEndpoints', 'retiredEndpoints'])
    && ['total', 'unknown', 'ready', 'busy', 'draining', 'unhealthy', 'retired'].every((key) => isCounter(value[key]))
    && [value.drainingEndpoints, value.retiredEndpoints].every((items) => Array.isArray(items) && items.every((item) => isRecord(item) && hasExactKeys(item, ['id', 'nodeId', 'runtimeId']) && isIdentifier(item.id) && isIdentifier(item.nodeId) && isIdentifier(item.runtimeId)));
}

function isMetricGroup(value: unknown, keys: readonly string[]): value is FleetMetricGroup {
  return isRecord(value) && hasExactKeys(value, keys) && keys.every((key) => isCounter(value[key]));
}

function isConnectionState(value: unknown): value is FleetConnectionState {
  return isTaggedState(value, {
    registered: [], probing: [], ready: ['observedAt'], unhealthy: ['observedAt'], deleted: ['deletedAt'], failed: [],
  }, { observedAt: (v) => isTimestamp(v) || v === null, deletedAt: isTimestamp });
}

function isEnvironmentState(value: unknown): value is FleetEnvironmentState {
  return isTaggedState(value, {
    registered: [], deploying: [], ready: ['readyAt'], deleting: [], deleted: ['deletedAt'], orphaned: [], failed: [],
  }, { readyAt: isTimestamp, deletedAt: isTimestamp });
}

function isResourceState(value: unknown): value is FleetResourceState {
  return isTaggedState(value, {
    observed: [], provisioning: [], ready: ['observedAt'], deleting: [], deleted: ['deletedAt'], conflict: [], failed: [],
  }, { observedAt: isTimestamp, deletedAt: isTimestamp });
}

function isCommandTarget(value: unknown): value is FleetCommandTarget {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'node') return hasExactKeys(value, ['kind', 'nodeId']) && isIdentifier(value.nodeId);
  if (value.kind === 'runtime') return hasExactKeys(value, ['kind', 'nodeId', 'runtimeId'])
    && isIdentifier(value.nodeId) && isIdentifier(value.runtimeId);
  return value.kind === 'endpoint' && hasExactKeys(value, ['kind', 'nodeId', 'runtimeId', 'endpointId'])
    && isIdentifier(value.nodeId) && isIdentifier(value.runtimeId) && isIdentifier(value.endpointId);
}

function isCommandState(value: unknown): value is FleetCommandState {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  switch (value.kind) {
    case 'queued': return hasExactKeys(value, ['kind', 'queuedAt']) && isTimestamp(value.queuedAt);
    case 'running': return hasExactKeys(value, ['kind', 'startedAt']) && isTimestamp(value.startedAt);
    case 'succeeded': return hasExactKeys(value, ['kind', 'completedAt']) && isTimestamp(value.completedAt);
    case 'failed': return hasExactKeys(value, ['kind', 'completedAt', 'failure']) && isTimestamp(value.completedAt)
      && isOneOf(value.failure, ['rejected', 'unavailable', 'executionFailed']);
    case 'cancelled': return hasExactKeys(value, ['kind', 'completedAt', 'reason']) && isTimestamp(value.completedAt)
      && (value.reason === null || isOneOf(value.reason, ['requested', 'superseded']));
    case 'timedOut': return hasExactKeys(value, ['kind', 'completedAt']) && isTimestamp(value.completedAt);
    case 'outcomeUnknown': return hasExactKeys(value, ['kind', 'observedAt']) && isTimestamp(value.observedAt);
    default: return false;
  }
}

function isTaggedState(
  value: unknown,
  variants: Readonly<Record<string, readonly string[]>>,
  fields: Readonly<Record<string, (value: unknown) => boolean>>,
): boolean {
  if (!isRecord(value) || typeof value.kind !== 'string' || !Object.hasOwn(variants, value.kind)) return false;
  const expected = ['kind', ...variants[value.kind]];
  return hasExactKeys(value, expected) && expected.slice(1).every((key) => fields[key](value[key]));
}

function isFreshness(value: unknown): value is FleetNode['freshness'] {
  return isOneOf(value, ['current', 'stale', 'unknown', 'pruned']);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && /^unix:[0-9]+$/.test(value);
}

function isCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0');
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.includes(value as T);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
