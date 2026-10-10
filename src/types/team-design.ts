import { validateRuntimeEndpointRef, validateSessionIdentity, runtimeEndpointsEqual, type RuntimeEndpointRef, type SessionIdentity } from './desktop/runtime-address';

export interface TeamRoleBindingRecord {
  teamId?: string;
  runId: string;
  roleId: string;
  sessionRef?: string;
  status?: 'available';
  agentId: string;
  endpointRef: RuntimeEndpointRef;
  localSessionId: string;
  endpointSessionId: string;
  sessionIdentity: SessionIdentity;
}

export interface TeamGraphNodeRecord {
  nodeId: string;
  kind?: string;
  title?: string;
  roleId?: string | null;
  groupId?: string | null;
  taskId?: string | null;
  stageId?: string;
  status?: string;
  statusReason?: string | null;
  maxAttempts?: number;
  createdAt?: number;
  completedAt?: number;
  artifactId?: string;
  executor?: Record<string, unknown>;
  config?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export type TeamGraphEdgeAction = 'activate' | 'rework' | 'gate' | 'finish';

export interface TeamGraphEdgePayloadPolicyRecord {
  includeUpstreamResult: boolean;
}

export interface TeamGraphEdgeRecord {
  edgeId: string;
  sourceNodeId: string;
  targetNodeId: string;
  fromNodeId?: string;
  toNodeId?: string;
  sourcePort?: string;
  targetPort?: string;
  edgeType?: string;
  kind?: string;
  action?: TeamGraphEdgeAction;
  payload?: TeamGraphEdgePayloadPolicyRecord;
  dependency?: { dependencyTaskId: string; taskId: string } | null;
  status?: string;
  label?: string;
  metadata?: Record<string, unknown>;
}

export interface TeamGraphNodePositionRecord {
  x: number;
  y: number;
}

export interface TeamGraphLayoutRecord {
  nodePositions?: Record<string, TeamGraphNodePositionRecord>;
}

export interface TeamGraphSnapshotRecord {
  runId?: string;
  graphId?: string;
  workflowPlanId?: string | null;
  title?: string;
  layout?: TeamGraphLayoutRecord;
  nodes: TeamGraphNodeRecord[];
  edges: TeamGraphEdgeRecord[];
  status: string;
  updatedAt?: number;
  metadata?: Record<string, unknown>;
}

export type TeamStartGateStatus = 'intake' | 'designing' | 'started';

export type TeamRunStartGateProjection =
  | { status: 'intake' | 'started' }
  | { status: 'designing'; designEpoch: string; graphVersion: string };

export type TeamGraphPatchOperation =
  | { op: 'add_node' | 'replace_node'; node: Record<string, unknown> }
  | { op: 'remove_node'; nodeId: string }
  | { op: 'add_edge' | 'replace_edge'; edge: Record<string, unknown> }
  | { op: 'remove_edge'; edgeId: string }
  | { op: 'set_node_position'; nodeId: string; position: TeamGraphNodePositionRecord }
  | { op: 'set_metadata'; metadata: Record<string, unknown> };

export interface TeamDesignTarget {
  teamId: string;
  runId: string;
}

export interface TeamDesignSnapshot extends TeamDesignTarget {
  success: true;
  startGate: TeamRunStartGateProjection;
  graphVersion: string;
  designEpoch: string | null;
  graph: TeamGraphSnapshotRecord;
  roles: TeamRoleBindingRecord[];
}

export interface TeamDesignRecord {
  snapshot: TeamDesignSnapshot | null;
  loading: boolean;
  mutationPending: boolean;
  error: string | null;
}

export interface TeamDesignFailure {
  success: false;
  error: string;
  errorCode: string;
  nodeId?: string;
  edgeId?: string;
}

export function isTeamDesignFailure(value: unknown): value is TeamDesignFailure {
  return isRecord(value) && onlyKeys(value, ['success', 'error', 'errorCode', 'nodeId', 'edgeId'])
    && value.success === false && isText(value.error) && value.error.length <= 4096 && !/[\0\p{Cc}]/u.test(value.error)
    && typeof value.errorCode === 'string' && /^[a-z_]{1,128}$/.test(value.errorCode)
    && [value.nodeId, value.edgeId].every((id) => id === undefined || (typeof id === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(id)));
}

export function decodeTeamDesignSnapshot(value: unknown, target: TeamDesignTarget): TeamDesignSnapshot {
  if (isTeamDesignFailure(value)) throw new Error(value.error, { cause: value });
  if (!isRecord(value) || !exactKeys(value, ['success', 'teamId', 'runId', 'startGate', 'graphVersion', 'designEpoch', 'graph', 'roles'])
    || value.success !== true || value.teamId !== target.teamId || value.runId !== target.runId
    || !isTeamGraphVersion(value.graphVersion) || !(value.designEpoch === null || isText(value.designEpoch))
    || !isStartGate(value.startGate, value.designEpoch, value.graphVersion)
    || !isGraph(value.graph, target.runId) || !Array.isArray(value.roles)
    || !value.roles.every((role) => isRole(role, target))) {
    throw new Error('Team design snapshot is unavailable');
  }
  return value as unknown as TeamDesignSnapshot;
}

export function decodeTeamDesignMutation<T extends 'designing' | 'intake' | 'started'>(value: unknown, outcome: T): { success: true; outcome: T } {
  if (isTeamDesignFailure(value)) throw new Error(value.error, { cause: value });
  if (!isRecord(value) || !exactKeys(value, ['success', 'outcome']) || value.success !== true || value.outcome !== outcome) {
    throw new Error('Team design outcome is unavailable');
  }
  return { success: true, outcome };
}

export function isTeamGraphVersion(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isStartGate(value: unknown, epoch: unknown, version: string): boolean {
  if (!isRecord(value)) return false;
  if (value.status === 'designing') {
    return exactKeys(value, ['status', 'designEpoch', 'graphVersion'])
      && typeof value.designEpoch === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value.designEpoch)
      && value.designEpoch === epoch && value.graphVersion === version;
  }
  return (value.status === 'intake' || value.status === 'started')
    && exactKeys(value, ['status']) && epoch === null;
}

export function isTeamDesignPatchOperation(value: unknown): value is TeamGraphPatchOperation {
  if (!isRecord(value)) return false;
  switch (value.op) {
    case 'add_node':
    case 'replace_node': return exactKeys(value, ['op', 'node']) && isRecord(value.node);
    case 'remove_node': return exactKeys(value, ['op', 'nodeId']) && isText(value.nodeId);
    case 'add_edge':
    case 'replace_edge': return exactKeys(value, ['op', 'edge']) && isRecord(value.edge);
    case 'remove_edge': return exactKeys(value, ['op', 'edgeId']) && isText(value.edgeId);
    case 'set_node_position': return exactKeys(value, ['op', 'nodeId', 'position']) && isText(value.nodeId) && isPosition(value.position);
    case 'set_metadata': return exactKeys(value, ['op', 'metadata']) && isRecord(value.metadata);
    default: return false;
  }
}

function isGraph(value: unknown, runId: string): boolean {
  return isRecord(value) && exactKeys(value, ['runId', 'graphId', 'workflowPlanId', 'title', 'layout', 'nodes', 'edges', 'status'])
    && value.runId === runId && isText(value.graphId) && (value.workflowPlanId === null || isText(value.workflowPlanId))
    && typeof value.title === 'string' && typeof value.status === 'string'
    && Array.isArray(value.nodes) && value.nodes.every(isNode)
    && Array.isArray(value.edges) && value.edges.every(isEdge) && isLayout(value.layout);
}

function isNode(value: unknown): boolean {
  return isRecord(value) && exactKeys(value, ['nodeId', 'kind', 'title', 'roleId', 'taskId', 'groupId', 'maxAttempts', 'status', 'statusReason', 'config'])
    && isText(value.nodeId) && ['start', 'work', 'review', 'human_decision', 'script_review', 'join', 'end'].includes(String(value.kind))
    && typeof value.title === 'string' && nullableText(value.roleId) && nullableText(value.taskId) && nullableText(value.groupId)
    && typeof value.maxAttempts === 'number' && Number.isSafeInteger(value.maxAttempts) && value.maxAttempts > 0
    && typeof value.status === 'string' && nullableText(value.statusReason) && isNodeConfig(value.config);
}

function isNodeConfig(value: unknown): boolean {
  if (!isRecord(value) || !onlyKeys(value, ['prompt', 'outputArtifactKind', 'sessionRef', 'trigger', 'join'])) return false;
  if (value.prompt !== undefined && typeof value.prompt !== 'string') return false;
  if (value.outputArtifactKind !== undefined && !isText(value.outputArtifactKind)) return false;
  if (value.sessionRef !== undefined && !isText(value.sessionRef)) return false;
  if (value.trigger !== undefined) {
    const trigger = value.trigger;
    if (!isRecord(trigger) || !(trigger.mode === 'webhook'
      ? exactKeys(trigger, ['mode', 'path']) && typeof trigger.path === 'string'
      : trigger.mode === 'cron' && exactKeys(trigger, ['mode', 'cron']) && isText(trigger.cron))) return false;
  }
  if (value.join !== undefined) {
    const join = value.join;
    if (!isRecord(join) || !exactKeys(join, ['requireCompleted', 'allowFailed', 'retryLimit'])
      || typeof join.requireCompleted !== 'boolean' || typeof join.allowFailed !== 'boolean'
      || typeof join.retryLimit !== 'number' || !Number.isSafeInteger(join.retryLimit) || join.retryLimit < 0) return false;
  }
  return true;
}

function isEdge(value: unknown): boolean {
  return isRecord(value) && exactKeys(value, ['edgeId', 'sourceNodeId', 'targetNodeId', 'sourcePort', 'targetPort', 'action', 'payload', 'dependency', 'status'])
    && isText(value.edgeId) && isText(value.sourceNodeId) && isText(value.targetNodeId)
    && isText(value.sourcePort) && isText(value.targetPort) && ['activate', 'rework', 'gate', 'finish'].includes(String(value.action))
    && isRecord(value.payload) && exactKeys(value.payload, ['includeUpstreamResult']) && typeof value.payload.includeUpstreamResult === 'boolean'
    && (value.dependency === null || (isRecord(value.dependency) && exactKeys(value.dependency, ['dependencyTaskId', 'taskId'])
      && isText(value.dependency.dependencyTaskId) && isText(value.dependency.taskId))) && typeof value.status === 'string';
}

function isLayout(value: unknown): boolean {
  return isRecord(value) && exactKeys(value, ['nodePositions']) && isRecord(value.nodePositions)
    && Object.values(value.nodePositions).every(isPosition);
}

function isPosition(value: unknown): boolean {
  return isRecord(value) && exactKeys(value, ['x', 'y'])
    && typeof value.x === 'number' && Number.isFinite(value.x)
    && typeof value.y === 'number' && Number.isFinite(value.y);
}

function nullableText(value: unknown): boolean {
  return value === null || isText(value);
}

function isRole(value: unknown, target: TeamDesignTarget): boolean {
  return isRecord(value) && exactKeys(value, ['teamId', 'runId', 'roleId', 'sessionRef', 'status', 'agentId', 'endpointRef', 'localSessionId', 'endpointSessionId', 'sessionIdentity'])
    && value.teamId === target.teamId && value.runId === target.runId && isText(value.sessionRef) && value.status === 'available'
    && isText(value.roleId) && isText(value.agentId) && isText(value.localSessionId) && isText(value.endpointSessionId)
    && validateRuntimeEndpointRef(value.endpointRef) === null && validateSessionIdentity(value.sessionIdentity) === null
    && isRecord(value.sessionIdentity) && value.sessionIdentity.agentId === value.agentId
    && value.sessionIdentity.sessionKey === value.localSessionId
    && runtimeEndpointsEqual(value.endpointRef as TeamRoleBindingRecord['endpointRef'], value.sessionIdentity.endpoint as TeamRoleBindingRecord['endpointRef']);
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
