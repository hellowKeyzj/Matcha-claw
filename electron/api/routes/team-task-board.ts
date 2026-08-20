import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TeamTaskBoardTransport } from '../../main/runtime-host-delivery/transport/teams/task-board';
import { parseJsonBody, sendJson } from '../route-utils';

const INVALID = {
  success: false,
  error: 'Team task board request is invalid',
} as const;
const UNAVAILABLE = {
  success: false,
  error: 'Team task board is unavailable',
} as const;
const MAX_REQUEST_BYTES = 8 * 1024;

type TaskBoardReadRequest = Readonly<{
  action: 'read';
  teamId: string;
  runId: string;
}>;
type TaskBoardMutationRequest = Readonly<{
  action: 'mutate';
  teamId: string;
  runId: string;
  operation: TaskBoardOperation;
  payload: TaskBoardPayload;
}> & Record<string, unknown>;
type TaskBoardRequest = TaskBoardReadRequest | TaskBoardMutationRequest;
type TaskBoardOperation =
  | 'claimNext'
  | 'heartbeat'
  | 'release'
  | 'transition'
  | 'startRunner'
  | 'pauseRunner'
  | 'closeRunner'
  | 'reclaimExpired'
  | 'postMailbox'
  | 'pullMailbox'
  | 'upsertPlan';
type TaskBoardPayload = Record<string, unknown>;

export async function handleTeamTaskBoardRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  transport: TeamTaskBoardTransport,
): Promise<boolean> {
  if (url.pathname !== '/api/team/task-board' || req.method !== 'POST') return false;

  let request: unknown;
  try {
    request = await parseJsonBody<unknown>(req);
  } catch {
    sendJson(res, 400, INVALID);
    return true;
  }
  if (!isRequest(request) || Buffer.byteLength(JSON.stringify(request), 'utf8') > MAX_REQUEST_BYTES) {
    sendJson(res, 400, INVALID);
    return true;
  }

  try {
    const response = request.action === 'read'
      ? await transport.read({ teamId: request.teamId, runId: request.runId })
      : await transport.mutate(request);
    sendJson(res, response.status, response.body);
  } catch {
    sendJson(res, 503, UNAVAILABLE);
  }
  return true;
}

function isRequest(value: unknown): value is TaskBoardRequest {
  if (!isRecord(value)) return false;
  if (value.action === 'read') {
    return hasExactKeys(value, ['action', 'teamId', 'runId'])
      && isTeamId(value.teamId)
      && isText(value.runId);
  }
  return value.action === 'mutate'
    && hasExactKeys(value, ['action', 'teamId', 'runId', 'operation', 'payload'])
    && isTeamId(value.teamId)
    && isText(value.runId)
    && isOperation(value.operation)
    && isPayload(value.operation, value.payload);
}

function isPayload(operation: TaskBoardOperation, value: unknown): value is TaskBoardPayload {
  if (!isRecord(value)) return false;
  switch (operation) {
    case 'claimNext':
      return hasExactKeys(value, ['agentId', 'session', 'leaseSeconds', 'now'])
        && isText(value.agentId)
        && isText(value.session)
        && isUint(value.leaseSeconds)
        && isUint(value.now);
    case 'heartbeat':
      return hasExactKeys(value, ['taskId', 'agentId', 'session', 'leaseSeconds', 'now'])
        && isTaskId(value.taskId)
        && isText(value.agentId)
        && isText(value.session)
        && isUint(value.leaseSeconds)
        && isUint(value.now);
    case 'release':
      return hasExactKeys(value, ['taskId', 'agentId', 'session', 'now'])
        && isTaskId(value.taskId)
        && isText(value.agentId)
        && isText(value.session)
        && isUint(value.now);
    case 'transition':
      return isTransition(value);
    case 'startRunner':
    case 'pauseRunner':
    case 'closeRunner':
      return hasExactKeys(value, ['runnerId', 'session', 'now'])
        && isText(value.runnerId)
        && isText(value.session)
        && isUint(value.now);
    case 'reclaimExpired':
      return hasExactKeys(value, ['now']) && isUint(value.now);
    case 'postMailbox':
      return hasExactKeys(value, [
        'msgId',
        'fromAgentId',
        'to',
        'relatedTaskId',
        'replyToMsgId',
        'kind',
        'content',
        'createdAt',
      ])
        && isText(value.msgId)
        && isText(value.fromAgentId)
        && isText(value.to)
        && (value.relatedTaskId === null || isTaskId(value.relatedTaskId))
        && isOptionalText(value.replyToMsgId)
        && isMailboxKind(value.kind)
        && isText(value.content)
        && isUint(value.createdAt);
    case 'pullMailbox':
      return value.cursor === undefined
        ? hasExactKeys(value, ['limit']) && isUint(value.limit)
        : hasExactKeys(value, ['cursor', 'limit'])
          && isOptionalText(value.cursor)
          && isUint(value.limit);
    case 'upsertPlan':
      return hasExactKeys(value, ['plan', 'now', 'fingerprint'])
        && Array.isArray(value.plan)
        && value.plan.every(isPlanEntry)
        && isUint(value.now)
        && isText(value.fingerprint);
  }
}

function isTransition(value: Record<string, unknown>): boolean {
  const hasAgent = Object.hasOwn(value, 'agentId') || Object.hasOwn(value, 'session');
  const expected = hasAgent
    ? ['taskId', 'next', 'agentId', 'session', 'summary', 'error', 'now']
    : ['taskId', 'next', 'summary', 'error', 'now'];
  return hasExactKeys(value, expected)
    && isTaskId(value.taskId)
    && isTaskStatus(value.next)
    && (!hasAgent || (isText(value.agentId) && isText(value.session)))
    && isOptionalText(value.summary)
    && isOptionalText(value.error)
    && isUint(value.now);
}

function isPlanEntry(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['taskId', 'title', 'instruction', 'dependsOn'])
    && isTaskId(value.taskId)
    && isText(value.title)
    && isText(value.instruction)
    && Array.isArray(value.dependsOn)
    && value.dependsOn.every(isTaskId);
}

function isOperation(value: unknown): value is TaskBoardOperation {
  return value === 'claimNext'
    || value === 'heartbeat'
    || value === 'release'
    || value === 'transition'
    || value === 'startRunner'
    || value === 'pauseRunner'
    || value === 'closeRunner'
    || value === 'reclaimExpired'
    || value === 'postMailbox'
    || value === 'pullMailbox'
    || value === 'upsertPlan';
}

function isTaskStatus(value: unknown): boolean {
  return value === 'todo'
    || value === 'claimed'
    || value === 'running'
    || value === 'blocked'
    || value === 'done'
    || value === 'failed';
}

function isMailboxKind(value: unknown): boolean {
  return value === 'question'
    || value === 'proposal'
    || value === 'decision'
    || value === 'report';
}

function isTeamId(value: unknown): value is string {
  return isText(value) && value.trim().length > 0;
}

function isTaskId(value: unknown): value is string {
  return isText(value) && value.trim().length > 0 && value.length <= 256;
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !/[\p{Cc}]/u.test(value);
}

function isOptionalText(value: unknown): boolean {
  return value === null || isText(value);
}

function isUint(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
