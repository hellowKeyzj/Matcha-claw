import type { RuntimeHostDeliveryIssuer } from '../issuer';
import { logger } from '../../../utils/logger';
import { decodeTaskFailure, decodeTaskFailureResponse, taskFailureResponse, type TaskFailure } from '../../../../src/types/desktop/task-failure';
import { hasExactKeys, isJsonValue, isNonEmptyBoundedText as isString, isRecord, isSafeNonNegativeInteger as isTimestamp, sendLoopbackJsonDelivery } from './client';

type Operation =
  | 'tasks.list' | 'tasks.get' | 'tasks.create' | 'tasks.update'
  | 'todos.get' | 'todos.write';
type Endpoint = Readonly<{ kind: 'native-runtime'; runtimeAdapterId: 'openclaw' | 'matcha-agent'; runtimeInstanceId: 'local' }>;
type Identity = Readonly<{ endpoint: Endpoint; agentId: string; sessionKey: string }>;
type TaskRequest = Readonly<{
  id: 'task.management';
  operationId: Operation;
  scope: Readonly<{ kind: 'session'; identity: Identity }>;
  target: Readonly<{ kind: 'task-manager'; identity: Identity }>;
  input: Record<string, unknown>;
}>;

export type TaskManagerTransportResponse = Readonly<{ status: 200 | 409 | 503; body: unknown }>;

export interface TaskManagerTransport {
  list(request: unknown): Promise<TaskManagerTransportResponse>;
  get(request: unknown): Promise<TaskManagerTransportResponse>;
  create(request: unknown): Promise<TaskManagerTransportResponse>;
  update(request: unknown): Promise<TaskManagerTransportResponse>;
  getTodos(request: unknown): Promise<TaskManagerTransportResponse>;
  writeTodos(request: unknown): Promise<TaskManagerTransportResponse>;
}

const details: Record<Operation, Readonly<{ path: string; scope: string; capability: TaskRequest['id']; subject: string }>> = {
  'tasks.list': { path: '/api/tasks/list', scope: 'tasks:read', capability: 'task.management', subject: 'tasks-list' },
  'tasks.get': { path: '/api/tasks/get', scope: 'tasks:read', capability: 'task.management', subject: 'tasks-get' },
  'tasks.create': { path: '/api/tasks/create', scope: 'tasks:write', capability: 'task.management', subject: 'tasks-create' },
  'tasks.update': { path: '/api/tasks/update', scope: 'tasks:write', capability: 'task.management', subject: 'tasks-update' },
  'todos.get': { path: '/api/tasks/todos/get', scope: 'tasks:read', capability: 'task.management', subject: 'todos-get' },
  'todos.write': { path: '/api/tasks/todos/write', scope: 'tasks:write', capability: 'task.management', subject: 'todos-write' },
};

export function createTaskManagerTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): TaskManagerTransport {
  const send = async (operation: Operation, request: unknown): Promise<TaskManagerTransportResponse> => {
    const fail = (failure: TaskFailure, status: 409 | 503 = 503, reason?: string): TaskManagerTransportResponse => {
      logger.warn('[TaskManager] Delivery failed', { operation, status, ...failure, ...(reason ? { reason } : {}) });
      return { status, body: taskFailureResponse(failure) };
    };
    if (!isRequest(request, operation)) return fail({ stage: 'task_request', code: 'invalid_params', delivery: 'notSent' });
    const detail = details[operation];
    const delivery = await sendLoopbackJsonDelivery({
      port: runtimeHostTransportPort,
      path: detail.path,
      issuer,
      decision: {
        endpoint: detail.path,
        scope: detail.scope,
        capability: detail.capability,
        subject: detail.subject,
      },
      method: 'POST',
      fetcher,
      body: request,
    });
    if (delivery.outcome !== 'response') {
      return fail({
        stage: delivery.reason === 'invalid_response' ? 'response' : 'transport',
        code: delivery.reason === 'invalid_response' ? 'protocol' : 'transport',
        delivery: delivery.outcome === 'not-attempted' ? 'notSent' : 'unknown',
      }, 503, delivery.reason);
    }
    const response = delivery.response;
    if (response.status === 200) {
      if (!isSuccess(response.body, operation)) return fail({ stage: 'response', code: 'protocol', delivery: 'responseReceived' });
      if (response.body.outcome === 'rejected' || response.body.outcome === 'unknown') {
        const failure = decodeTaskFailure(response.body.failure);
        logger.warn('[TaskManager] Mutation not applied', { operation, outcome: response.body.outcome, diagnosticPresent: failure !== null, ...failure });
      }
      return { status: 200, body: response.body };
    }
    if (response.status === 409 || response.status === 503) {
      const failure = decodeTaskFailureResponse(response.body);
      if (failure) return fail(failure.failure, response.status);
      if (isPublicFailure(response.body)) {
        logger.warn('[TaskManager] Runtime request failed without diagnostics', { operation, status: response.status });
        return { status: response.status, body: response.body };
      }
      return fail({ stage: 'response', code: 'protocol', delivery: 'responseReceived' });
    }
    return fail({
      stage: 'response',
      code: response.status === 400 ? 'invalid_params'
        : response.status === 401 || response.status === 403 ? 'authentication_failed'
          : response.status === 404 ? 'method_not_found'
            : response.status >= 400 ? 'remote_error' : 'protocol',
      delivery: 'responseReceived',
    });
  };
  return {
    list: (request) => send('tasks.list', request), get: (request) => send('tasks.get', request),
    create: (request) => send('tasks.create', request), update: (request) => send('tasks.update', request),
    getTodos: (request) => send('todos.get', request), writeTodos: (request) => send('todos.write', request),
  };
}

function isRequest(value: unknown, operation: Operation): value is TaskRequest {
  if (!isRecord(value) || !hasExactKeys(value, ['id', 'operationId', 'scope', 'target', 'input'])
    || value.operationId !== operation || !isScope(value.scope) || !isTarget(value.target)
    || !isInput(value.input, operation)) return false;
  return value.id === 'task.management'
    && sameIdentity(value.scope.identity, value.target.identity)
    && sameIdentity(value.scope.identity, value.input.sessionIdentity as Identity);
}

function isScope(value: unknown): value is { kind: 'session'; identity: Identity } {
  return isRecord(value) && hasExactKeys(value, ['kind', 'identity']) && value.kind === 'session' && isIdentity(value.identity);
}
function isTarget(value: unknown): value is { kind: 'task-manager'; identity: Identity } {
  return isRecord(value) && hasExactKeys(value, ['kind', 'identity'])
    && value.kind === 'task-manager'
    && isIdentity(value.identity);
}
function isInput(value: unknown, operation: Operation): value is Record<string, unknown> & { sessionIdentity: Identity } {
  if (!isRecord(value) || !isIdentity(value.sessionIdentity)) return false;
  const allowed: Record<Operation, readonly string[]> = {
    'tasks.list': ['sessionIdentity', 'teamKey'], 'tasks.get': ['sessionIdentity', 'teamKey', 'taskId'],
    'tasks.create': ['sessionIdentity', 'teamKey', 'subject', 'description', 'activeForm', 'owner', 'metadata'],
    'tasks.update': ['sessionIdentity', 'teamKey', 'taskId', 'status', 'subject', 'description', 'activeForm', 'owner', 'addBlockedBy', 'addBlocks', 'metadata'],
    'todos.get': ['sessionIdentity'], 'todos.write': ['sessionIdentity', 'oldTodos', 'newTodos'],
  };
  if (!Object.keys(value).every((key) => allowed[operation].includes(key))) return false;
  if (value.teamKey !== undefined && !isString(value.teamKey)) return false;
  if ((operation === 'tasks.get' || operation === 'tasks.update') && !isString(value.taskId)) return false;
  if (operation === 'tasks.create' && (!isString(value.subject) || !isString(value.description))) return false;
  if (value.activeForm !== undefined && !isString(value.activeForm) || value.owner !== undefined && !isString(value.owner)) return false;
  if (value.status !== undefined && !['pending', 'in_progress', 'completed', 'deleted'].includes(value.status as string)) return false;
  if ((value.addBlockedBy !== undefined && !isStringArray(value.addBlockedBy)) || (value.addBlocks !== undefined && !isStringArray(value.addBlocks))) return false;
  if ((operation === 'tasks.create' || operation === 'tasks.update')
    && Object.hasOwn(value, 'metadata') && !isTaskMetadata(value.metadata)) return false;
  return operation !== 'todos.write' || (isTodos(value.oldTodos) && isTodos(value.newTodos));
}
function isTodos(value: unknown): boolean {
  return Array.isArray(value) && value.every((todo) => isRecord(todo) && Object.keys(todo).every((key) => ['id', 'content', 'activeForm', 'status', 'owner'].includes(key))
    && isString(todo.content) && ['pending', 'in_progress', 'completed', 'deleted'].includes(todo.status as string)
    && (todo.id === undefined || isString(todo.id)) && (todo.activeForm === undefined || isString(todo.activeForm)) && (todo.owner === undefined || isString(todo.owner)));
}
function isSuccess(value: unknown, operation: Operation): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  if (operation === 'tasks.list') return isSnapshot(value);
  if (operation === 'tasks.get') return hasExactKeys(value, ['task']) && (value.task === null || isTask(value.task));
  if (operation === 'todos.get') return isTodoSnapshot(value);
  if (operation === 'todos.write') return (hasExactKeys(value, ['outcome', 'snapshot']) && value.outcome === 'applied' && isTodoSnapshot(value.snapshot) && isTimestamp(value.snapshot.updatedAt))
    || isClosedMutation(value);
  if (operation === 'tasks.create') {
    return (hasExactKeys(value, ['outcome', 'task', 'snapshot']) && value.outcome === 'applied'
      && isTask(value.task) && isSnapshot(value.snapshot))
      || isClosedMutation(value);
  }
  return (hasExactKeys(value, ['outcome', 'snapshot']) && value.outcome === 'applied' && isSnapshot(value.snapshot))
    || isClosedMutation(value);
}
function isClosedMutation(value: Record<string, unknown>): boolean {
  return (hasExactKeys(value, ['outcome']) || (hasExactKeys(value, ['outcome', 'failure']) && decodeTaskFailure(value.failure) !== null))
    && (value.outcome === 'rejected' || value.outcome === 'unknown');
}
function isSnapshot(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['tasks', 'todos']) && Array.isArray(value.tasks) && value.tasks.every(isTask)
    && Array.isArray(value.todos) && value.todos.every(isTodo);
}
function isTodoSnapshot(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).every((key) => ['todos', 'updatedAt'].includes(key))
    && Array.isArray(value.todos) && value.todos.every(isTodo)
    && (!Object.hasOwn(value, 'updatedAt') || isTimestamp(value.updatedAt));
}
function isTask(value: unknown): boolean {
  if (!isRecord(value) || !isString(value.id) || !isString(value.subject) || !isString(value.description)
    || !['pending', 'in_progress', 'completed', 'deleted'].includes(value.status as string)
    || !isStringArray(value.blockedBy) || !isStringArray(value.blocks) || !isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt)) return false;
  return Object.keys(value).every((key) => ['id', 'subject', 'description', 'status', 'blockedBy', 'blocks', 'activeForm', 'owner', 'metadata', 'createdAt', 'updatedAt'].includes(key))
    && (value.activeForm === undefined || isString(value.activeForm))
    && (value.owner === undefined || isString(value.owner))
    && (!Object.hasOwn(value, 'metadata') || isTaskMetadata(value.metadata));
}
function isTodo(value: unknown): boolean {
  return isRecord(value) && isString(value.content) && ['pending', 'in_progress', 'completed', 'deleted'].includes(value.status as string)
    && Object.keys(value).every((key) => ['id', 'content', 'activeForm', 'status', 'owner'].includes(key))
    && (value.id === undefined || isString(value.id)) && (value.activeForm === undefined || isString(value.activeForm)) && (value.owner === undefined || isString(value.owner));
}
function isTaskMetadata(value: unknown): boolean {
  return isRecord(value) && isJsonValue(value, new Set<object>());
}
function isIdentity(value: unknown): value is Identity {
  return isRecord(value) && hasExactKeys(value, ['endpoint', 'agentId', 'sessionKey']) && isEndpoint(value.endpoint)
    && isString(value.agentId) && isString(value.sessionKey);
}
function isEndpoint(value: unknown): value is Endpoint {
  return isRecord(value) && hasExactKeys(value, ['kind', 'runtimeAdapterId', 'runtimeInstanceId'])
    && value.kind === 'native-runtime' && (value.runtimeAdapterId === 'openclaw' || value.runtimeAdapterId === 'matcha-agent') && value.runtimeInstanceId === 'local';
}
function sameIdentity(left: Identity, right: Identity): boolean { return left.agentId === right.agentId && left.sessionKey === right.sessionKey && left.endpoint.runtimeAdapterId === right.endpoint.runtimeAdapterId && left.endpoint.runtimeInstanceId === right.endpoint.runtimeInstanceId; }
function isPublicFailure(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['success', 'error']) && value.success === false
    && (value.error === 'Task manager is unavailable' || value.error === 'Task manager request was rejected');
}
function isStringArray(value: unknown): boolean { return Array.isArray(value) && value.every((item) => isString(item)); }
