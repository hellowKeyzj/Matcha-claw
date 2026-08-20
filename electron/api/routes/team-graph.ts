import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  TeamGraphDefinition,
  TeamGraphNode,
  TeamGraphTransport,
} from '../../main/runtime-host-delivery/transport/teams/graph';
import { parseJsonBody, sendJson } from '../route-utils';

const INVALID = {
  success: false,
  error: 'Team graph request is invalid',
} as const;
const UNAVAILABLE = {
  success: false,
  error: 'Team graph is unavailable',
} as const;

type TeamGraphRequest =
  | Readonly<{ action: 'export'; teamId: string; runId: string }>
  | Readonly<{
      action: 'replace';
      teamId: string;
      commandId?: string;
      idempotencyKey: string;
      graph: TeamGraphDefinition;
    }>
  | Readonly<{
      action: 'import';
      teamId: string;
      commandId?: string;
      idempotencyKey: string;
      yaml: string;
    }>;

export async function handleTeamGraphRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  transport: TeamGraphTransport,
): Promise<boolean> {
  if (url.pathname !== '/api/team/graph' || req.method !== 'POST') return false;

  let request: unknown;
  try {
    request = await parseJsonBody<unknown>(req);
  } catch {
    sendJson(res, 400, INVALID);
    return true;
  }
  if (!isRequest(request)) {
    sendJson(res, 400, INVALID);
    return true;
  }

  try {
    const response = request.action === 'export'
      ? await transport.export({ teamId: request.teamId, runId: request.runId })
      : request.action === 'replace'
        ? await transport.replace({ teamId: request.teamId, ...(request.commandId ? { commandId: request.commandId } : {}), idempotencyKey: request.idempotencyKey, graph: request.graph })
        : await transport.import({ teamId: request.teamId, ...(request.commandId ? { commandId: request.commandId } : {}), idempotencyKey: request.idempotencyKey, yaml: request.yaml });
    sendJson(res, response.status, response.body);
  } catch {
    sendJson(res, 503, UNAVAILABLE);
  }
  return true;
}

function isRequest(value: unknown): value is TeamGraphRequest {
  if (!isRecord(value)) return false;
  if (value.action === 'export') {
    return hasExactKeys(value, ['action', 'teamId', 'runId'])
      && isIdentifier(value.teamId)
      && isIdentifier(value.runId);
  }
  if (value.action === 'replace') {
    return hasOnlyKeys(value, ['action', 'teamId', 'commandId', 'idempotencyKey', 'graph'])
      && hasRequiredKeys(value, ['action', 'teamId', 'idempotencyKey', 'graph'])
      && isIdentifier(value.teamId)
      && (value.commandId === undefined || isOpaqueId(value.commandId))
      && isOpaqueId(value.idempotencyKey)
      && isGraphDefinition(value.graph);
  }
  return value.action === 'import'
    && hasOnlyKeys(value, ['action', 'teamId', 'commandId', 'idempotencyKey', 'yaml'])
    && hasRequiredKeys(value, ['action', 'teamId', 'idempotencyKey', 'yaml'])
    && isIdentifier(value.teamId)
    && (value.commandId === undefined || isOpaqueId(value.commandId))
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

function isEdgeAction(value: unknown): boolean {
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

function hasRequiredKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  return required.every((key) => Object.hasOwn(value, key));
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
