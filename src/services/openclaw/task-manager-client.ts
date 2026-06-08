import { hostApiFetch } from '@/lib/host-api';
import type { SessionIdentity } from '../../../runtime-host/shared/runtime-address';

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

const TOOL_INVOKE_CAPABILITY_ID = 'tool.invoke';
const TASK_CONTROL_CAPABILITY_ID = 'task.control';

async function taskToolApi<T>(operationId: string, payload: {
  sessionIdentity: SessionIdentity;
  method: string;
  params: Record<string, unknown>;
}): Promise<T> {
  return await hostApiFetch<T>('/api/capabilities/execute', {
    method: 'POST',
    body: JSON.stringify({
      id: TOOL_INVOKE_CAPABILITY_ID,
      operationId,
      scope: { kind: 'session', identity: payload.sessionIdentity },
      target: { kind: 'tool', toolName: payload.method, identity: payload.sessionIdentity },
      input: payload,
    }),
    timeoutMs: 60_000,
  });
}

async function taskControlApi<T>(operationId: string, payload: {
  sessionIdentity: SessionIdentity;
  taskId: string;
  wait?: boolean;
  timeoutMs?: number;
}): Promise<T> {
  return await hostApiFetch<T>('/api/capabilities/execute', {
    method: 'POST',
    body: JSON.stringify({
      id: TASK_CONTROL_CAPABILITY_ID,
      operationId,
      scope: { kind: 'session', identity: payload.sessionIdentity },
      target: { kind: 'task', taskId: payload.taskId, owner: { kind: 'session', identity: payload.sessionIdentity } },
      input: payload,
    }),
    timeoutMs: payload.timeoutMs ?? 60_000,
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

export async function listTaskSnapshot(payload: {
  sessionKey: string;
  sessionIdentity: SessionIdentity;
  teamKey?: string;
}): Promise<TaskListSnapshot> {
  const result = await taskToolApi<{ scope?: unknown; tasks?: unknown[]; todos?: unknown[] }>('tools.invoke', {
    sessionIdentity: payload.sessionIdentity,
    method: 'TaskList',
    params: {
      sessionKey: payload.sessionKey,
      ...(payload.teamKey ? { teamKey: payload.teamKey } : {}),
    },
  });
  const tasks = Array.isArray(result.tasks) ? result.tasks.map(normalizeTask) : [];
  const todos = Array.isArray(result.todos) ? result.todos.map(normalizeTodo) : [];
  return { ...(normalizeScope(result.scope) ? { scope: normalizeScope(result.scope) } : {}), tasks, todos };
}

export async function getTask(payload: { sessionKey: string; sessionIdentity: SessionIdentity; taskId: string }): Promise<Task | null> {
  const result = await taskToolApi<{ task?: unknown | null }>('tools.invoke', {
    sessionIdentity: payload.sessionIdentity,
    method: 'TaskGet',
    params: {
      sessionKey: payload.sessionKey,
      taskId: payload.taskId,
    },
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
}): Promise<{ task: Task; todos: TodoItem[] }> {
  const result = await taskToolApi<{ task: unknown; todos?: unknown[] }>('tools.invoke', {
    sessionIdentity: payload.sessionIdentity,
    method: 'TaskCreate',
    params: {
      sessionKey: payload.sessionKey,
      subject: payload.subject,
      description: payload.description,
      ...(payload.activeForm ? { activeForm: payload.activeForm } : {}),
      ...(payload.metadata ? { metadata: payload.metadata } : {}),
      ...(payload.owner ? { owner: payload.owner } : {}),
    },
  });
  return {
    task: normalizeTask(result.task),
    todos: Array.isArray(result.todos) ? result.todos.map(normalizeTodo) : [],
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
}): Promise<{ task?: Task; taskId?: string; deleted?: boolean; todos: TodoItem[] }> {
  const result = await taskToolApi<{ task?: unknown; taskId?: string; deleted?: boolean; todos?: unknown[] }>('tools.invoke', {
    sessionIdentity: payload.sessionIdentity,
    method: 'TaskUpdate',
    params: {
      sessionKey: payload.sessionKey,
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
  return {
    ...(result.task ? { task: normalizeTask(result.task) } : {}),
    ...(typeof result.taskId === 'string' ? { taskId: result.taskId } : {}),
    ...(result.deleted === true ? { deleted: true } : {}),
    todos: Array.isArray(result.todos) ? result.todos.map(normalizeTodo) : [],
  };
}

export async function writeTodos(payload: {
  sessionKey: string;
  sessionIdentity: SessionIdentity;
  oldTodos: TodoItem[];
  newTodos: TodoItem[];
}): Promise<{ todos: TodoItem[]; updatedAt?: number }> {
  const result = await taskToolApi<{ todos?: unknown[]; updatedAt?: unknown }>('tools.invoke', {
    sessionIdentity: payload.sessionIdentity,
    method: 'TodoWrite',
    params: {
      sessionKey: payload.sessionKey,
      oldTodos: payload.oldTodos,
      newTodos: payload.newTodos,
    },
  });
  return {
    todos: Array.isArray(result.todos) ? result.todos.map(normalizeTodo) : [],
    ...(typeof result.updatedAt === 'number' ? { updatedAt: result.updatedAt } : {}),
  };
}

export async function getTodos(payload: {
  sessionKey: string;
  sessionIdentity: SessionIdentity;
}): Promise<{ todos: TodoItem[]; updatedAt?: number }> {
  const result = await taskToolApi<{ todos?: unknown[]; updatedAt?: unknown }>('tools.invoke', {
    sessionIdentity: payload.sessionIdentity,
    method: 'TodoGet',
    params: {
      sessionKey: payload.sessionKey,
    },
  });
  return {
    todos: Array.isArray(result.todos) ? result.todos.map(normalizeTodo) : [],
    ...(typeof result.updatedAt === 'number' ? { updatedAt: result.updatedAt } : {}),
  };
}

export async function getTaskOutput(payload: {
  sessionIdentity: SessionIdentity;
  taskId: string;
  wait?: boolean;
  timeoutMs?: number;
}): Promise<unknown> {
  return await taskControlApi('tasks.output', payload);
}

export async function stopTask(payload: {
  sessionIdentity: SessionIdentity;
  taskId: string;
}): Promise<unknown> {
  return await taskControlApi('tasks.stop', payload);
}
