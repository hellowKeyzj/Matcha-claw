import { randomUUID } from 'node:crypto';
import type { RuntimeHostDeliveryIssuer } from '../../bootstrap';

const DECISION_TTL_MS = 30_000;
const UNAVAILABLE = {
  success: false,
  error: 'Team graph is unavailable',
} as const;
const REJECTED = {
  success: false,
  error: 'Team graph update was rejected',
} as const;

export type TeamGraphNodeKind = 'start' | 'work' | 'review' | 'humanDecision' | 'scriptReview' | 'join' | 'end';
export type TeamGraphEdgeAction = 'activate' | 'rework' | 'gate' | 'finish';

type TeamGraphBaseNode = Readonly<{
  id: string;
  kind: TeamGraphNodeKind;
  title: string;
  maxAttempts: number;
}>;

type TeamGraphStartNode = TeamGraphBaseNode & Readonly<{
  kind: 'start';
  trigger?: Readonly<{ kind: 'webhook'; path: string }> | Readonly<{ kind: 'cron'; expression: string }> | null;
}>;

type TeamGraphWorkNode = TeamGraphBaseNode & Readonly<{
  kind: 'work';
  work: Readonly<{
    taskId: string;
    roleId: string;
    prompt?: string;
    executor?: Readonly<{ kind: 'team-role'; roleId: string }>;
    outputArtifactKind?: string;
    groupId?: string;
  }>;
}>;

type TeamGraphJoinNode = TeamGraphBaseNode & Readonly<{
  kind: 'join';
  group: Readonly<{
    groupId: string;
    join: Readonly<{
      requireCompleted: boolean;
      allowFailed: boolean;
      retryLimit: number;
    }>;
  }>;
}>;

type TeamGraphControlNode = TeamGraphBaseNode & Readonly<{
  kind: 'review' | 'humanDecision' | 'scriptReview' | 'end';
}>;

export type TeamGraphNode = TeamGraphStartNode | TeamGraphWorkNode | TeamGraphJoinNode | TeamGraphControlNode;

export type TeamGraphDefinition = Readonly<{
  graphId: string;
  workflowPlanId: string;
  runId: string;
  title: string;
  nodes: readonly TeamGraphNode[];
  edges: readonly Readonly<{
    id: string;
    from: string;
    sourcePort: string;
    to: string;
    targetPort: string;
    action: TeamGraphEdgeAction;
    payload?: Readonly<{ includeUpstreamResult: boolean }>;
    dependency?: Readonly<{ dependencyTaskId: string; taskId: string }>;
  }>[];
}>;

export type TeamGraphTransportResponse = Readonly<{
  status: 200 | 404 | 409 | 503;
  body: Readonly<{ success: true; action: 'export'; runId: string; yaml: string }>
    | Readonly<{ success: true; action: 'replace'; runId: string }>
    | Readonly<{ success: true; action: 'import'; runId: string }>
    | typeof UNAVAILABLE
    | typeof REJECTED;
}>;

export interface TeamGraphTransport {
  export(request: Readonly<{ teamId: string; runId: string }>): Promise<TeamGraphTransportResponse>;
  replace(request: Readonly<{ teamId: string; commandId?: string; idempotencyKey: string; graph: TeamGraphDefinition }>): Promise<TeamGraphTransportResponse>;
  import(request: Readonly<{ teamId: string; commandId?: string; idempotencyKey: string; yaml: string }>): Promise<TeamGraphTransportResponse>;
}

export function createTeamGraphTransport(
  issuer: RuntimeHostDeliveryIssuer,
  port: number,
  fetcher: typeof fetch = fetch,
): TeamGraphTransport {
  const url = `http://127.0.0.1:${port}/api/team/graph`;
  return {
    export: (request) => send(url, issuer, fetcher, { action: 'export', ...request }),
    replace: (request) => send(url, issuer, fetcher, {
      action: 'replace',
      teamId: request.teamId,
      commandId: request.commandId ?? `graph:${randomUUID()}`,
      idempotencyKey: request.idempotencyKey,
      graph: request.graph,
    }),
    import: (request) => send(url, issuer, fetcher, {
      action: 'import',
      teamId: request.teamId,
      commandId: request.commandId ?? `graph:${randomUUID()}`,
      idempotencyKey: request.idempotencyKey,
      yaml: request.yaml,
    }),
  };
}

async function send(
  url: string,
  issuer: RuntimeHostDeliveryIssuer,
  fetcher: typeof fetch,
  body: Record<string, unknown>,
): Promise<TeamGraphTransportResponse> {
  if (!isRequest(body)) return { status: 409, body: REJECTED };
  try {
    const response = await fetcher(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${issuer.signDecision({
          principal: 'electron-main-local',
          endpoint: '/api/team/graph',
          scope: 'team:write',
          capability: 'team.graph.yaml',
          subject: 'team-graph-yaml',
          expiresAt: Date.now() + DECISION_TTL_MS,
          revision: '1',
        })}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const result: unknown = await response.json();
    if (response.status === 200 && isSuccess(result)) return { status: 200, body: result };
    if (response.status === 404 && isUnavailable(result)) return { status: 404, body: result };
    if (response.status === 409 && isRejected(result)) return { status: 409, body: result };
  } catch {
    // Native transport details do not cross the Electron delivery boundary.
  }
  return { status: 503, body: UNAVAILABLE };
}

function isRequest(value: Record<string, unknown>): boolean {
  if (value.action === 'export') {
    return hasExactKeys(value, ['action', 'teamId', 'runId'])
      && isIdentifier(value.teamId)
      && isIdentifier(value.runId);
  }
  if (value.action === 'replace') {
    return hasExactKeys(value, ['action', 'teamId', 'commandId', 'idempotencyKey', 'graph'])
      && isIdentifier(value.teamId)
      && isOpaqueId(value.commandId)
      && isOpaqueId(value.idempotencyKey)
      && isGraphDefinition(value.graph);
  }
  return value.action === 'import'
    && hasExactKeys(value, ['action', 'teamId', 'commandId', 'idempotencyKey', 'yaml'])
    && isIdentifier(value.teamId)
    && isOpaqueId(value.commandId)
    && isOpaqueId(value.idempotencyKey)
    && isYaml(value.yaml);
}

function isGraphDefinition(value: unknown): value is TeamGraphDefinition {
  return isRecord(value)
    && hasExactKeys(value, ['graphId', 'workflowPlanId', 'runId', 'title', 'nodes', 'edges'])
    && isIdentifier(value.graphId)
    && isIdentifier(value.workflowPlanId)
    && isIdentifier(value.runId)
    && isIdentifier(value.title)
    && Array.isArray(value.nodes)
    && value.nodes.every(isGraphNode)
    && Array.isArray(value.edges)
    && value.edges.every(isGraphEdge);
}

function isGraphNode(value: unknown): value is TeamGraphNode {
  if (!isRecord(value)
    || !isIdentifier(value.id)
    || !isIdentifier(value.title)
    || !isPositiveUint(value.maxAttempts)) {
    return false;
  }
  if (value.kind === 'start') {
    const expected = value.trigger === undefined ? ['id', 'kind', 'title', 'maxAttempts'] : ['id', 'kind', 'title', 'maxAttempts', 'trigger'];
    return hasExactKeys(value, expected) && isTrigger(value.trigger);
  }
  if (value.kind === 'work') {
    return hasExactKeys(value, ['id', 'kind', 'title', 'maxAttempts', 'work']) && isWork(value.work);
  }
  if (value.kind === 'join') {
    return hasExactKeys(value, ['id', 'kind', 'title', 'maxAttempts', 'group']) && isGroup(value.group);
  }
  return hasExactKeys(value, ['id', 'kind', 'title', 'maxAttempts'])
    && (value.kind === 'review' || value.kind === 'humanDecision' || value.kind === 'scriptReview' || value.kind === 'end');
}

function isTrigger(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return isRecord(value)
    && ((hasExactKeys(value, ['kind', 'path']) && value.kind === 'webhook' && isIdentifier(value.path))
      || (hasExactKeys(value, ['kind', 'expression']) && value.kind === 'cron' && isIdentifier(value.expression)));
}

function isWork(value: unknown): boolean {
  if (!isRecord(value) || !isIdentifier(value.taskId) || !isIdentifier(value.roleId)) return false;
  if (!hasOnlyKeys(value, ['taskId', 'roleId', 'prompt', 'executor', 'outputArtifactKind', 'groupId'])) return false;
  return (value.prompt === undefined || isIdentifier(value.prompt))
    && (value.outputArtifactKind === undefined || isIdentifier(value.outputArtifactKind))
    && (value.groupId === undefined || isIdentifier(value.groupId))
    && (value.executor === undefined || (isRecord(value.executor)
      && hasExactKeys(value.executor, ['kind', 'roleId'])
      && value.executor.kind === 'team-role'
      && value.executor.roleId === value.roleId));
}

function isGroup(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['groupId', 'join'])
    && isIdentifier(value.groupId)
    && isRecord(value.join)
    && hasExactKeys(value.join, ['requireCompleted', 'allowFailed', 'retryLimit'])
    && typeof value.join.requireCompleted === 'boolean'
    && typeof value.join.allowFailed === 'boolean'
    && isUint(value.join.retryLimit);
}

function isGraphEdge(value: unknown): boolean {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['id', 'from', 'sourcePort', 'to', 'targetPort', 'action', 'payload', 'dependency'])
    || !isIdentifier(value.id)
    || !isIdentifier(value.from)
    || !isIdentifier(value.sourcePort)
    || !isIdentifier(value.to)
    || !isIdentifier(value.targetPort)
    || !isEdgeAction(value.action)) {
    return false;
  }
  return (value.payload === undefined || (isRecord(value.payload)
    && hasExactKeys(value.payload, ['includeUpstreamResult'])
    && typeof value.payload.includeUpstreamResult === 'boolean'))
    && (value.dependency === undefined || (isRecord(value.dependency)
      && hasExactKeys(value.dependency, ['dependencyTaskId', 'taskId'])
      && isIdentifier(value.dependency.dependencyTaskId)
      && isIdentifier(value.dependency.taskId)));
}

function isEdgeAction(value: unknown): value is TeamGraphEdgeAction {
  return value === 'activate' || value === 'rework' || value === 'gate' || value === 'finish';
}

function isYaml(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 * 1024 && !value.includes('\0');
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

function isPositiveUint(value: unknown): value is number {
  return isUint(value) && value > 0;
}

function isUint(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isSuccess(value: unknown): value is TeamGraphTransportResponse['body'] {
  return isRecord(value)
    && value.success === true
    && ((hasExactKeys(value, ['success', 'action', 'runId', 'yaml']) && value.action === 'export' && isIdentifier(value.runId) && typeof value.yaml === 'string')
      || (hasExactKeys(value, ['success', 'action', 'runId'])
        && (value.action === 'replace' || value.action === 'import')
        && isIdentifier(value.runId)));
}

function isUnavailable(value: unknown): value is typeof UNAVAILABLE {
  return isRecord(value) && hasExactKeys(value, ['success', 'error']) && value.success === false && value.error === UNAVAILABLE.error;
}

function isRejected(value: unknown): value is typeof REJECTED {
  return isRecord(value) && hasExactKeys(value, ['success', 'error']) && value.success === false && value.error === REJECTED.error;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\0\p{Cc}]/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
