import { hostApiFetch, hostCapabilityDescribe } from '@/lib/host-api';
import {
  buildSessionIdentityKey,
  sessionScope,
  type SessionIdentity,
} from '../../types/desktop/runtime-address';

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted';

export interface Task {
  id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  owner?: string;
  blockedBy: string[];
  blocks: string[];
  activeForm?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface TodoItem {
  id?: string;
  content: string;
  activeForm?: string;
  status: TaskStatus;
  owner?: string;
}

export interface TaskScope {
  type: 'session' | 'team';
  key: string;
  label: string;
  sessionKey?: string;
  teamKey?: string;
  agentId?: string;
}

export interface TaskListSnapshot {
  scope?: TaskScope;
  tasks: Task[];
  todos: TodoItem[];
}

type ClosedTaskMutation = { outcome: 'rejected' | 'unknown' };
export class TaskManagementUnavailableError extends Error {
  constructor() {
    super('Task management is not available for this session');
    this.name = 'TaskManagementUnavailableError';
  }
}
export interface TodoSnapshot {
  todos: TodoItem[];
  updatedAt?: number;
}

export type TaskCreateResult = { outcome: 'applied'; task: Task; snapshot: TaskListSnapshot } | ClosedTaskMutation;
export type TaskUpdateResult = { outcome: 'applied'; snapshot: TaskListSnapshot } | ClosedTaskMutation;
export type TodoWriteResult = { outcome: 'applied'; snapshot: TodoSnapshot } | ClosedTaskMutation;

type TaskOperation =
  | 'tasks.list'
  | 'tasks.get'
  | 'tasks.create'
  | 'tasks.update'
  | 'todos.get'
  | 'todos.write';

const TASK_MANAGEMENT_CAPABILITY_ID = 'task.management';
const availableTaskManagementCapabilityKeys = new Set<string>();

export async function isTaskManagementAvailable(sessionIdentity: SessionIdentity): Promise<boolean> {
  const cacheKey = buildSessionIdentityKey(sessionIdentity);
  if (availableTaskManagementCapabilityKeys.has(cacheKey)) {
    return true;
  }
  try {
    const { capability } = await hostCapabilityDescribe({
      id: TASK_MANAGEMENT_CAPABILITY_ID,
      scope: sessionScope(sessionIdentity),
    });
    const available = capability.availability === 'available'
      && capability.operations.some((operation) => operation.id === 'tasks.list');
    if (available) {
      availableTaskManagementCapabilityKeys.add(cacheKey);
    }
    return available;
  } catch (error) {
    if (error instanceof Error && error.message === 'Capability is not available') {
      return false;
    }
    throw error;
  }
}

async function taskManagementApi<T>(operationId: TaskOperation, payload: {
  sessionKey: string;
  sessionIdentity: SessionIdentity;
  input: Record<string, unknown>;
}): Promise<T> {
  if (!payload.sessionKey || payload.sessionKey !== payload.sessionIdentity.sessionKey) {
    throw new Error('Task manager session identity is invalid');
  }
  const identity = payload.sessionIdentity;
  if (!await isTaskManagementAvailable(identity)) {
    throw new TaskManagementUnavailableError();
  }
  return await hostApiFetch<T>('/api/capabilities/execute', {
    method: 'POST',
    body: JSON.stringify({
      id: TASK_MANAGEMENT_CAPABILITY_ID,
      operationId,
      scope: { kind: 'session', identity },
      target: { kind: 'task-manager', identity },
      input: { sessionIdentity: identity, ...payload.input },
    }),
    timeoutMs: 60_000,
  });
}

function normalizeStatus(raw: unknown): TaskStatus {
  if (raw === 'in_progress' || raw === 'completed' || raw === 'deleted') {
    return raw;
  }
  return 'pending';
}

function normalizeStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((item): item is string => typeof item === 'string');
}

function normalizeTask(raw: unknown): Task {
  const row = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const subject = typeof row.subject === 'string' && row.subject.trim().length > 0
    ? row.subject.trim()
    : 'Untitled task';
  const createdAt = typeof row.createdAt === 'number' ? row.createdAt : Date.now();
  const updatedAt = typeof row.updatedAt === 'number' ? row.updatedAt : createdAt;

  return {
    id: typeof row.id === 'string' ? row.id : '',
    subject,
    description: typeof row.description === 'string' ? row.description : '',
    status: normalizeStatus(row.status),
    ...(typeof row.owner === 'string' && row.owner.trim().length > 0 ? { owner: row.owner.trim() } : {}),
    blockedBy: normalizeStringArray(row.blockedBy),
    blocks: normalizeStringArray(row.blocks),
    ...(typeof row.activeForm === 'string' && row.activeForm.trim().length > 0 ? { activeForm: row.activeForm.trim() } : {}),
    ...(row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
      ? { metadata: row.metadata as Record<string, unknown> }
      : {}),
    createdAt,
    updatedAt,
  };
}

function normalizeTodo(raw: unknown): TodoItem {
  const row = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    ...(typeof row.id === 'string' && row.id.trim().length > 0 ? { id: row.id.trim() } : {}),
    content: typeof row.content === 'string' ? row.content : '',
    ...(typeof row.activeForm === 'string' && row.activeForm.trim().length > 0 ? { activeForm: row.activeForm.trim() } : {}),
    status: normalizeStatus(row.status),
    ...(typeof row.owner === 'string' && row.owner.trim().length > 0 ? { owner: row.owner.trim() } : {}),
  };
}

function normalizeScope(raw: unknown): TaskScope | undefined {
  const row = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const key = typeof row.key === 'string' && row.key.trim().length > 0 ? row.key.trim() : '';
  if (!key) {
    return undefined;
  }
  const type = row.type === 'team' ? 'team' : 'session';
  return {
    type,
    key,
    label: typeof row.label === 'string' && row.label.trim().length > 0 ? row.label.trim() : key,
    ...(typeof row.sessionKey === 'string' && row.sessionKey.trim().length > 0 ? { sessionKey: row.sessionKey.trim() } : {}),
    ...(typeof row.teamKey === 'string' && row.teamKey.trim().length > 0 ? { teamKey: row.teamKey.trim() } : {}),
    ...(typeof row.agentId === 'string' && row.agentId.trim().length > 0 ? { agentId: row.agentId.trim() } : {}),
  };
}

function normalizeSnapshot(raw: unknown): TaskListSnapshot {
  const row = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const scope = normalizeScope(row.scope);
  return {
    ...(scope ? { scope } : {}),
    tasks: Array.isArray(row.tasks) ? row.tasks.map(normalizeTask) : [],
    todos: Array.isArray(row.todos) ? row.todos.map(normalizeTodo) : [],
  };
}

function normalizeTodoSnapshot(raw: unknown): TodoSnapshot {
  const row = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    todos: Array.isArray(row.todos) ? row.todos.map(normalizeTodo) : [],
    ...(typeof row.updatedAt === 'number' ? { updatedAt: row.updatedAt } : {}),
  };
}

export async function listTaskSnapshot(payload: {
  sessionKey: string;
  sessionIdentity: SessionIdentity;
  teamKey?: string;
}): Promise<TaskListSnapshot> {
  try {
    const result = await taskManagementApi<{ scope?: unknown; tasks?: unknown[]; todos?: unknown[] }>('tasks.list', {
      sessionKey: payload.sessionKey,
      sessionIdentity: payload.sessionIdentity,
      input: {
        ...(payload.teamKey ? { teamKey: payload.teamKey } : {}),
      },
    });
    return normalizeSnapshot(result);
  } catch (error) {
    if (error instanceof TaskManagementUnavailableError) {
      return { tasks: [], todos: [] };
    }
    throw error;
  }
}

export async function getTask(payload: { sessionKey: string; sessionIdentity: SessionIdentity; taskId: string }): Promise<Task | null> {
  const result = await taskManagementApi<{ task?: unknown | null }>('tasks.get', {
    sessionKey: payload.sessionKey,
    sessionIdentity: payload.sessionIdentity,
    input: { taskId: payload.taskId },
  });
  return result.task ? normalizeTask(result.task) : null;
}

export async function createTask(payload: {
  sessionKey: string;
  sessionIdentity: SessionIdentity;
  subject: string;
  description: string;
  activeForm?: string;
  metadata?: Record<string, unknown>;
  owner?: string;
}): Promise<TaskCreateResult> {
  const result = await taskManagementApi<
    | { outcome: 'applied'; task: unknown; snapshot: unknown }
    | ClosedTaskMutation
  >('tasks.create', {
    sessionKey: payload.sessionKey,
    sessionIdentity: payload.sessionIdentity,
    input: {
      subject: payload.subject,
      description: payload.description,
      ...(payload.activeForm ? { activeForm: payload.activeForm } : {}),
      ...(payload.metadata ? { metadata: payload.metadata } : {}),
      ...(payload.owner ? { owner: payload.owner } : {}),
    },
  });
  if (result.outcome !== 'applied') {
    return result;
  }
  return {
    outcome: 'applied',
    task: normalizeTask(result.task),
    snapshot: normalizeSnapshot(result.snapshot),
  };
}

export async function updateTask(payload: {
  sessionKey: string;
  sessionIdentity: SessionIdentity;
  taskId: string;
  teamKey?: string;
  status?: TaskStatus;
  subject?: string;
  description?: string;
  activeForm?: string;
  owner?: string;
  addBlockedBy?: string[];
  addBlocks?: string[];
  metadata?: Record<string, unknown>;
}): Promise<TaskUpdateResult> {
  const result = await taskManagementApi<
    | { outcome: 'applied'; snapshot: unknown }
    | ClosedTaskMutation
  >('tasks.update', {
    sessionKey: payload.sessionKey,
    sessionIdentity: payload.sessionIdentity,
    input: {
      taskId: payload.taskId,
      ...(payload.teamKey ? { teamKey: payload.teamKey } : {}),
      ...(payload.status ? { status: payload.status } : {}),
      ...(payload.subject ? { subject: payload.subject } : {}),
      ...(typeof payload.description === 'string' ? { description: payload.description } : {}),
      ...(payload.activeForm ? { activeForm: payload.activeForm } : {}),
      ...(payload.owner ? { owner: payload.owner } : {}),
      ...(payload.addBlockedBy ? { addBlockedBy: payload.addBlockedBy } : {}),
      ...(payload.addBlocks ? { addBlocks: payload.addBlocks } : {}),
      ...(payload.metadata ? { metadata: payload.metadata } : {}),
    },
  });
  if (result.outcome !== 'applied') {
    return result;
  }
  return {
    outcome: 'applied',
    snapshot: normalizeSnapshot(result.snapshot),
  };
}

export async function writeTodos(payload: {
  sessionKey: string;
  sessionIdentity: SessionIdentity;
  oldTodos: TodoItem[];
  newTodos: TodoItem[];
}): Promise<TodoWriteResult> {
  const result = await taskManagementApi<
    | { outcome: 'applied'; snapshot: unknown }
    | ClosedTaskMutation
  >('todos.write', {
    sessionKey: payload.sessionKey,
    sessionIdentity: payload.sessionIdentity,
    input: {
      oldTodos: payload.oldTodos,
      newTodos: payload.newTodos,
    },
  });
  if (result.outcome !== 'applied') {
    return result;
  }
  return {
    outcome: 'applied',
    snapshot: normalizeTodoSnapshot(result.snapshot),
  };
}

export async function getTodos(payload: {
  sessionKey: string;
  sessionIdentity: SessionIdentity;
}): Promise<TodoSnapshot> {
  const result = await taskManagementApi<{ todos?: unknown[]; updatedAt?: unknown }>('todos.get', {
    sessionKey: payload.sessionKey,
    sessionIdentity: payload.sessionIdentity,
    input: {},
  });
  return normalizeTodoSnapshot(result);
}
