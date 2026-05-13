import type { TaskData, TaskDataStatus, TaskSnapshotEvent, TodoItem } from '../../shared/session-adapter-types';
import {
  canonicalizeStateOnlyTaskToolName,
  canonicalizeTaskSnapshotToolName,
} from '../../shared/task-tool-contract';
import { isRecord, normalizeString } from './session-value-normalization';

function normalizeStatus(value: unknown): TaskDataStatus {
  if (value === 'in_progress' || value === 'completed' || value === 'deleted') {
    return value;
  }
  return 'pending';
}

function normalizeStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
    : [];
}

function normalizeTask(raw: unknown, index = 0): TaskData | null {
  if (!isRecord(raw)) {
    return null;
  }
  const subject = normalizeString(raw.subject ?? raw.content ?? raw.title);
  if (!subject) {
    return null;
  }
  const dependencies = normalizeStringList(raw.dependencies);
  return {
    id: normalizeString(raw.id) || String(index + 1),
    subject,
    description: typeof raw.description === 'string' ? raw.description : '',
    ...(normalizeString(raw.activeForm) ? { activeForm: normalizeString(raw.activeForm) } : {}),
    status: normalizeStatus(raw.status),
    ...(isRecord(raw.metadata) ? { metadata: raw.metadata } : {}),
    ...(normalizeString(raw.owner) ? { owner: normalizeString(raw.owner) } : {}),
    blocks: normalizeStringList(raw.blocks),
    blockedBy: normalizeStringList(raw.blockedBy),
    ...(typeof raw.createdAt === 'number' ? { createdAt: raw.createdAt } : {}),
    ...(typeof raw.updatedAt === 'number' ? { updatedAt: raw.updatedAt } : {}),
    ...(normalizeString(raw.content) ? { content: normalizeString(raw.content) } : {}),
    ...(dependencies.length > 0 ? { dependencies } : {}),
  };
}

function normalizeTasks(value: unknown): TaskData[] {
  return Array.isArray(value)
    ? value.map(normalizeTask).filter((item): item is TaskData => Boolean(item))
    : [];
}

function normalizeTodo(raw: unknown): TodoItem | null {
  if (!isRecord(raw)) {
    return null;
  }
  const content = normalizeString(raw.content ?? raw.subject ?? raw.title);
  if (!content) {
    return null;
  }
  return {
    ...(normalizeString(raw.id) ? { id: normalizeString(raw.id) } : {}),
    content,
    ...(normalizeString(raw.activeForm) ? { activeForm: normalizeString(raw.activeForm) } : {}),
    status: normalizeStatus(raw.status),
    ...(normalizeString(raw.owner) ? { owner: normalizeString(raw.owner) } : {}),
  };
}

function normalizeTodos(value: unknown): TodoItem[] {
  return Array.isArray(value)
    ? value.map(normalizeTodo).filter((item): item is TodoItem => Boolean(item))
    : [];
}

function readSessionKey(value: Record<string, unknown>, fallbackSessionKey?: string | null): string {
  const direct = normalizeString(value.sessionKey);
  if (direct) {
    return direct;
  }
  const uri = normalizeString(value.uri);
  const fromUri = uri.match(/^agent:\/\/\/(.+)\/tasks\//)?.[1] ?? '';
  return normalizeString(fromUri || fallbackSessionKey);
}

export function normalizeTaskSnapshotPayload(
  payload: unknown,
  fallbackSessionKey?: string | null,
): TaskSnapshotEvent | null {
  if (!isRecord(payload)) {
    return null;
  }
  const sessionKey = readSessionKey(payload, fallbackSessionKey);
  if (!sessionKey) {
    return null;
  }
  const tasks = [
    ...normalizeTasks(payload.tasks),
    ...normalizeTasks(payload.task ? [payload.task] : []),
  ];
  const todos = normalizeTodos(payload.todos ?? payload.newTodos);
  const rawSource = normalizeString(payload.source);
  const source = rawSource === 'plan' || rawSource === 'artifact' || rawSource === 'todo' || rawSource === 'replay'
    ? rawSource
    : 'tool';
  if (tasks.length === 0 && todos.length === 0 && source !== 'todo') {
    return null;
  }
  return {
    sessionKey,
    tasks,
    ...(todos.length > 0 || source === 'todo' ? { todos } : {}),
    source,
    ...(typeof payload.enableEdit === 'boolean' ? { enableEdit: payload.enableEdit } : {}),
    ...(normalizeString(payload.uri) ? { uri: normalizeString(payload.uri) } : {}),
  };
}

export function normalizeTaskToolSnapshot(
  toolName: unknown,
  payload: unknown,
  fallbackSessionKey?: string | null,
): TaskSnapshotEvent | null {
  const method = canonicalizeTaskSnapshotToolName(toolName);
  if (!method) {
    return null;
  }
  const stateOnlyMethod = canonicalizeStateOnlyTaskToolName(method);
  const normalizedPayload = stateOnlyMethod && isRecord(payload)
    ? { ...payload, source: 'todo' }
    : payload;
  const snapshot = normalizeTaskSnapshotPayload(normalizedPayload, fallbackSessionKey);
  if (!snapshot) {
    return null;
  }
  return {
    ...snapshot,
    source: stateOnlyMethod ? 'todo' : snapshot.source,
  };
}

export function normalizeTaskArtifactSnapshot(
  payload: unknown,
  fallbackSessionKey?: string | null,
): TaskSnapshotEvent | null {
  if (!isRecord(payload) || payload.type !== 'tasks') {
    return null;
  }
  const snapshot = normalizeTaskSnapshotPayload(payload, fallbackSessionKey);
  return snapshot ? { ...snapshot, source: 'artifact' } : null;
}
