import { hostApiFetch } from '@/lib/host-api';

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

export interface TaskListSnapshot {
  tasks: Task[];
  todos: TodoItem[];
}

async function taskApi<T>(path: string, payload?: unknown): Promise<T> {
  return await hostApiFetch<T>(path, {
    method: 'POST',
    body: JSON.stringify(payload ?? {}),
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

export async function listTaskSnapshot(sessionKey: string): Promise<TaskListSnapshot> {
  const result = await taskApi<{ tasks?: unknown[]; todos?: unknown[] }>('/api/tasks/list', { sessionKey });
  const tasks = Array.isArray(result.tasks) ? result.tasks.map(normalizeTask) : [];
  const todos = Array.isArray(result.todos) ? result.todos.map(normalizeTodo) : [];
  return { tasks, todos };
}

export async function getTask(payload: { sessionKey: string; taskId: string }): Promise<Task | null> {
  const result = await taskApi<{ task?: unknown | null }>('/api/tasks/get', payload);
  return result.task ? normalizeTask(result.task) : null;
}

export async function createTask(payload: {
  sessionKey: string;
  subject: string;
  description: string;
  activeForm?: string;
  metadata?: Record<string, unknown>;
  owner?: string;
}): Promise<{ task: Task; todos: TodoItem[] }> {
  const result = await taskApi<{ task: unknown; todos?: unknown[] }>('/api/tasks/create', payload);
  return {
    task: normalizeTask(result.task),
    todos: Array.isArray(result.todos) ? result.todos.map(normalizeTodo) : [],
  };
}

export async function updateTask(payload: {
  sessionKey: string;
  taskId: string;
  status?: TaskStatus;
  subject?: string;
  description?: string;
  activeForm?: string;
  owner?: string;
  addBlockedBy?: string[];
  addBlocks?: string[];
  metadata?: Record<string, unknown>;
}): Promise<{ task?: Task; taskId?: string; deleted?: boolean; todos: TodoItem[] }> {
  const result = await taskApi<{ task?: unknown; taskId?: string; deleted?: boolean; todos?: unknown[] }>('/api/tasks/update', payload);
  return {
    ...(result.task ? { task: normalizeTask(result.task) } : {}),
    ...(typeof result.taskId === 'string' ? { taskId: result.taskId } : {}),
    ...(result.deleted === true ? { deleted: true } : {}),
    todos: Array.isArray(result.todos) ? result.todos.map(normalizeTodo) : [],
  };
}

export async function writeTodos(payload: {
  sessionKey: string;
  oldTodos?: TodoItem[];
  newTodos: TodoItem[];
}): Promise<{ todos: TodoItem[]; updatedAt?: number }> {
  const result = await taskApi<{ todos?: unknown[]; updatedAt?: unknown }>('/api/tasks/todos/write', payload);
  return {
    todos: Array.isArray(result.todos) ? result.todos.map(normalizeTodo) : [],
    ...(typeof result.updatedAt === 'number' ? { updatedAt: result.updatedAt } : {}),
  };
}

export async function getTodos(payload: {
  sessionKey: string;
}): Promise<{ todos: TodoItem[]; updatedAt?: number }> {
  const result = await taskApi<{ todos?: unknown[]; updatedAt?: unknown }>('/api/tasks/todos/get', payload);
  return {
    todos: Array.isArray(result.todos) ? result.todos.map(normalizeTodo) : [],
    ...(typeof result.updatedAt === 'number' ? { updatedAt: result.updatedAt } : {}),
  };
}

export async function getTaskOutput(payload: {
  sessionKey?: string;
  taskId: string;
  wait?: boolean;
  timeoutMs?: number;
}): Promise<unknown> {
  return await taskApi('/api/tasks/output', payload);
}

export async function stopTask(payload: {
  sessionKey?: string;
  taskId: string;
}): Promise<unknown> {
  return await taskApi('/api/tasks/stop', payload);
}
