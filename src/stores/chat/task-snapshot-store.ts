import { create } from 'zustand';
import { buildSessionRecordKey } from './session-identity';
import type {
  SessionAssistantTurnItem,
  SessionRenderToolCard,
  SessionStateSnapshot,
  SessionUpdateEvent,
  TaskData,
  TaskDataStatus,
  TaskScopeSnapshot,
  TaskSnapshotEvent,
  TodoItem,
} from '../../../runtime-host/shared/session-adapter-types';
import {
  isTaskSnapshotToolMethod,
  isTodoTaskToolName,
} from '../../../runtime-host/shared/task-tool-contract';

export type DerivedPlanStatus = 'finished' | 'building' | 'ready' | null;

interface SessionTaskSnapshotState {
  scope?: TaskScopeSnapshot;
  tasks: TaskData[];
  todos: TodoItem[];
  taskDataList: TaskData[];
  statusMap: Record<string, TaskDataStatus>;
  chatRunning: boolean;
  source?: TaskSnapshotEvent['source'];
  enableEdit?: boolean;
  uri?: string;
  updatedAt: number;
}

interface TaskSnapshotStoreState {
  snapshots: Record<string, SessionTaskSnapshotState>;
  reportTodos: (sessionKey: string, todos: TodoItem[]) => void;
  reportTaskCenterData: (
    sessionKey: string,
    tasks: TaskData[],
    options?: {
      scope?: TaskScopeSnapshot;
      source?: TaskSnapshotEvent['source'];
      enableEdit?: boolean;
      uri?: string;
      recordKey?: string;
    },
  ) => void;
  reportTaskCenterSnapshot: (event: TaskSnapshotEvent & { recordKey?: string }) => void;
  reportSessionUpdate: (event: SessionUpdateEvent) => void;
  reportSessionSnapshot: (snapshot: SessionStateSnapshot, source?: TaskSnapshotEvent['source']) => void;
  getTodoList: (sessionKey: string) => TodoItem[];
  getTaskDataList: (scopeKey: string) => TaskData[];
  getPersistentTaskDataList: (scopeKey: string) => TaskData[];
  getTaskScope: (scopeKey: string) => TaskScopeSnapshot | undefined;
  getSessionTaskScopeKey: (sessionKey: string) => string;
  getStatusMap: (scopeKey: string) => Record<string, TaskDataStatus>;
  getDerivedPlanStatus: (scopeKey: string) => DerivedPlanStatus;
  notifyChatStarted: (sessionKey: string) => void;
  notifyChatStopped: (sessionKey: string) => void;
  reset: (sessionKey: string) => void;
  cleanup: (sessionKey: string) => void;
}

const EMPTY_TASKS: TaskData[] = [];
const EMPTY_TODOS: TodoItem[] = [];
const EMPTY_STATUS_MAP: Record<string, TaskDataStatus> = {};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

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

function normalizeScope(raw: unknown): TaskScopeSnapshot | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const key = normalizeString(raw.key);
  if (!key) {
    return undefined;
  }
  return {
    type: raw.type === 'team' ? 'team' : 'session',
    key,
    label: normalizeString(raw.label) || key,
    ...(normalizeString(raw.sessionKey) ? { sessionKey: normalizeString(raw.sessionKey) } : {}),
    ...(normalizeString(raw.teamKey) ? { teamKey: normalizeString(raw.teamKey) } : {}),
    ...(normalizeString(raw.agentId) ? { agentId: normalizeString(raw.agentId) } : {}),
  };
}

function taskScopeKeyForSession(sessionKey: string): string {
  return normalizeString(sessionKey);
}

function fallbackTaskScopeForSession(recordKey: string, backendSessionKey = recordKey): TaskScopeSnapshot | undefined {
  const normalizedRecordKey = normalizeString(recordKey);
  if (!normalizedRecordKey) {
    return undefined;
  }
  const normalizedBackendSessionKey = normalizeString(backendSessionKey) || normalizedRecordKey;
  const agentId = /^agent:([^:]+):/.exec(normalizedBackendSessionKey)?.[1];
  return {
    type: 'session',
    key: normalizedRecordKey,
    label: agentId ? `${agentId} · ${normalizedBackendSessionKey.split(':').slice(2).join(':') || 'main'}` : normalizedBackendSessionKey,
    sessionKey: normalizedBackendSessionKey,
    ...(agentId ? { agentId } : {}),
  };
}

function areScopesEqual(left?: TaskScopeSnapshot, right?: TaskScopeSnapshot): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return left.type === right.type
    && left.key === right.key
    && left.label === right.label
    && (left.sessionKey ?? '') === (right.sessionKey ?? '')
    && (left.teamKey ?? '') === (right.teamKey ?? '')
    && (left.agentId ?? '') === (right.agentId ?? '');
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

function normalizeTask(raw: unknown, index = 0): TaskData | null {
  if (!isRecord(raw)) {
    return null;
  }
  const subject = normalizeString(raw.subject ?? raw.content ?? raw.title) || normalizeString(raw.id);
  if (!subject) {
    return null;
  }
  const id = normalizeString(raw.id) || String(index + 1);
  const metadata = isRecord(raw.metadata) ? raw.metadata : undefined;
  const dependencies = normalizeStringList(raw.dependencies);
  return {
    id,
    subject,
    description: typeof raw.description === 'string' ? raw.description : '',
    ...(normalizeString(raw.activeForm) ? { activeForm: normalizeString(raw.activeForm) } : {}),
    status: normalizeStatus(raw.status),
    ...(metadata ? { metadata } : {}),
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

function normalizeTodos(value: unknown): TodoItem[] {
  return Array.isArray(value)
    ? value.map(normalizeTodo).filter((item): item is TodoItem => Boolean(item))
    : [];
}

function todosToTaskData(todos: TodoItem[]): TaskData[] {
  if (todos.length === 0) {
    return EMPTY_TASKS;
  }
  return todos.map((todo, index) => ({
    id: todo.id || `todo-${index + 1}`,
    subject: todo.content,
    description: '',
    ...(todo.activeForm ? { activeForm: todo.activeForm } : {}),
    status: todo.status,
    ...(todo.owner ? { owner: todo.owner } : {}),
    blocks: [],
    blockedBy: [],
    content: todo.content,
  }));
}

function buildTaskDataList(tasks: TaskData[], todos: TodoItem[]): TaskData[] {
  return tasks.length > 0 ? tasks : todosToTaskData(todos);
}

function buildStatusMap(tasks: TaskData[]): Record<string, TaskDataStatus> {
  if (tasks.length === 0) {
    return EMPTY_STATUS_MAP;
  }
  return Object.fromEntries(tasks.map((task) => [task.id, task.status] as const));
}

function areStringListsEqual(left: string[] = [], right: string[] = []): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((item, index) => item === right[index]);
}

function areRecordsEqual(left?: Record<string, unknown>, right?: Record<string, unknown>): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  if (leftEntries.length !== rightEntries.length) {
    return false;
  }
  return leftEntries.every(([key, value]) => right[key] === value);
}

function areTasksEqual(left: TaskData[], right: TaskData[]): boolean {
  if (left === right) {
    return true;
  }
  if (left.length !== right.length) {
    return false;
  }
  return left.every((task, index) => {
    const other = right[index];
    return Boolean(other)
      && task.id === other.id
      && task.subject === other.subject
      && task.description === other.description
      && (task.activeForm ?? '') === (other.activeForm ?? '')
      && task.status === other.status
      && (task.owner ?? '') === (other.owner ?? '')
      && (task.createdAt ?? null) === (other.createdAt ?? null)
      && (task.updatedAt ?? null) === (other.updatedAt ?? null)
      && (task.content ?? '') === (other.content ?? '')
      && areRecordsEqual(task.metadata, other.metadata)
      && areStringListsEqual(task.blocks, other.blocks)
      && areStringListsEqual(task.blockedBy, other.blockedBy)
      && areStringListsEqual(task.dependencies, other.dependencies);
  });
}

function areTodosEqual(left: TodoItem[], right: TodoItem[]): boolean {
  if (left === right) {
    return true;
  }
  if (left.length !== right.length) {
    return false;
  }
  return left.every((todo, index) => {
    const other = right[index];
    return Boolean(other)
      && (todo.id ?? '') === (other.id ?? '')
      && todo.content === other.content
      && (todo.activeForm ?? '') === (other.activeForm ?? '')
      && todo.status === other.status
      && (todo.owner ?? '') === (other.owner ?? '');
  });
}

function sortTasks(tasks: TaskData[]): TaskData[] {
  return [...tasks].sort((left, right) => {
    const leftId = Number.parseInt(left.id, 10);
    const rightId = Number.parseInt(right.id, 10);
    if (Number.isFinite(leftId) && Number.isFinite(rightId) && leftId !== rightId) {
      return leftId - rightId;
    }
    return left.id.localeCompare(right.id);
  });
}

function parseJsonMaybe(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function normalizeToolPayload(method: string, params: Record<string, unknown>): {
  scope?: TaskScopeSnapshot;
  tasks: TaskData[];
  todos: TodoItem[];
  source: TaskSnapshotEvent['source'];
} | null {
  if (!isTaskSnapshotToolMethod(method)) {
    return null;
  }
  const tasks = [
    ...normalizeTasks(params.tasks),
    ...normalizeTasks(params.task ? [params.task] : []),
  ];
  const todos = normalizeTodos(params.todos ?? params.newTodos);
  if (isTodoTaskToolName(method)) {
    return { tasks: [], todos, source: 'todo' };
  }
  if (tasks.length === 0 && todos.length === 0) {
    return null;
  }
  return { scope: normalizeScope(params.scope), tasks, todos, source: 'tool' };
}

function extractTaskArtifactPayload(value: unknown): TaskSnapshotEvent | null {
  if (!isRecord(value) || value.type !== 'tasks') {
    return null;
  }
  const sessionKey = normalizeString(value.sessionKey)
    || normalizeString(value.uri).match(/^agent:\/\/\/(.+)\/tasks\//)?.[1]
    || '';
  if (!sessionKey) {
    return null;
  }
  return {
    sessionKey,
    ...(normalizeScope(value.scope) ? { scope: normalizeScope(value.scope) } : {}),
    tasks: normalizeTasks(value.tasks),
    source: 'artifact',
    enableEdit: value.enableEdit === true,
    ...(normalizeString(value.uri) ? { uri: normalizeString(value.uri) } : {}),
  };
}

function extractTasksFromTool(tool: SessionRenderToolCard, sessionKey: string): TaskSnapshotEvent | null {
  const outputCandidates: unknown[] = [tool.output];
  if (tool.result.kind === 'json' || tool.result.kind === 'text') {
    outputCandidates.push(parseJsonMaybe(tool.result.bodyText));
  }
  for (const candidate of outputCandidates) {
    if (!candidate) continue;
    const artifact = extractTaskArtifactPayload(candidate);
    if (artifact) return artifact;
    if (!isRecord(candidate)) continue;
    const normalized = normalizeToolPayload(tool.name, candidate);
    if (!normalized) continue;
    return {
      sessionKey,
      ...(normalized.scope ? { scope: normalized.scope } : {}),
      tasks: normalized.tasks,
      todos: normalized.todos,
      source: normalized.source,
    };
  }
  return null;
}

function extractSnapshotEventsFromItems(snapshot: SessionStateSnapshot): TaskSnapshotEvent[] {
  const events: TaskSnapshotEvent[] = [];
  for (const item of snapshot.items) {
    if (item.kind !== 'assistant-turn') {
      continue;
    }
    const turn = item as SessionAssistantTurnItem;
    for (const tool of turn.tools) {
      const event = extractTasksFromTool(tool, snapshot.sessionKey);
      if (event) {
        events.push(event);
      }
    }
  }
  return events;
}

function updateSnapshot(
  current: SessionTaskSnapshotState | undefined,
  patch: Partial<SessionTaskSnapshotState>,
): SessionTaskSnapshotState {
  const tasks = patch.tasks ?? current?.tasks ?? EMPTY_TASKS;
  const todos = patch.todos ?? current?.todos ?? EMPTY_TODOS;
  const taskDataList = current && current.tasks === tasks && current.todos === todos
    ? current.taskDataList
    : buildTaskDataList(tasks, todos);
  const statusMap = current && current.taskDataList === taskDataList
    ? current.statusMap
    : buildStatusMap(taskDataList);
  return {
    chatRunning: current?.chatRunning ?? false,
    updatedAt: Date.now(),
    ...current,
    ...patch,
    tasks,
    todos,
    taskDataList,
    statusMap,
  };
}

export const useTaskSnapshotStore = create<TaskSnapshotStoreState>((set, get) => ({
  snapshots: {},

  reportTodos: (sessionKey, todos) => {
    const normalizedSessionKey = normalizeString(sessionKey);
    if (!normalizedSessionKey) return;
    const normalizedTodos = normalizeTodos(todos);
    set((state) => {
      const current = state.snapshots[normalizedSessionKey];
      if (current && areTodosEqual(current.todos, normalizedTodos)) {
        return state;
      }
      return {
        snapshots: {
          ...state.snapshots,
          [normalizedSessionKey]: updateSnapshot(current, {
            todos: normalizedTodos,
            source: 'todo',
          }),
        },
      };
    });
  },

  reportTaskCenterData: (sessionKey, tasks, options) => {
    const backendSessionKey = normalizeString(sessionKey);
    if (!backendSessionKey) return;
    const recordKey = normalizeString(options?.recordKey) || backendSessionKey;
    const rawScope = normalizeScope(options?.scope);
    const normalizedScope = rawScope
      ? {
          ...rawScope,
          key: rawScope.type === 'session' ? recordKey : rawScope.key,
          ...(rawScope.type === 'session' ? { sessionKey: rawScope.sessionKey ?? backendSessionKey } : {}),
        }
      : fallbackTaskScopeForSession(recordKey, backendSessionKey);
    const snapshotKey = normalizedScope?.key || taskScopeKeyForSession(recordKey);
    if (!snapshotKey) return;
    const normalizedTasks = sortTasks(
      tasks
        .map(normalizeTask)
        .filter((item): item is TaskData => Boolean(item))
        .filter((task) => task.status !== 'deleted'),
    );
    set((state) => {
      const current = state.snapshots[snapshotKey];
      const nextSource = options?.source ?? current?.source ?? 'tool';
      const nextEnableEdit = options?.enableEdit ?? current?.enableEdit;
      const nextUri = options?.uri ?? current?.uri;
      if (
        current
        && areTasksEqual(current.tasks, normalizedTasks)
        && areScopesEqual(current.scope, normalizedScope)
        && current.source === nextSource
        && current.enableEdit === nextEnableEdit
        && current.uri === nextUri
      ) {
        return state;
      }
      return {
        snapshots: {
          ...state.snapshots,
          [snapshotKey]: updateSnapshot(current, {
            ...(normalizedScope ? { scope: normalizedScope } : {}),
            tasks: normalizedTasks,
            source: nextSource,
            enableEdit: nextEnableEdit,
            uri: nextUri,
          }),
        },
      };
    });
  },

  reportTaskCenterSnapshot: (event) => {
    const backendSessionKey = normalizeString(event.sessionKey);
    if (!backendSessionKey) return;
    const recordKey = normalizeString(event.recordKey) || backendSessionKey;
    if (event.source === 'todo') {
      get().reportTodos(recordKey, event.todos ?? []);
      return;
    }
    get().reportTaskCenterData(backendSessionKey, event.tasks, {
      scope: event.scope,
      source: event.source,
      enableEdit: event.enableEdit,
      uri: event.uri,
      recordKey,
    });
    if (event.todos) {
      get().reportTodos(recordKey, event.todos);
    }
  },

  reportSessionUpdate: (event) => {
    const backendSessionKey = normalizeString(event.sessionKey) || event.snapshot.sessionKey;
    if (!backendSessionKey) return;
    const recordKey = buildSessionRecordKey(event.snapshot.catalog.runtimeAddress, backendSessionKey);
    if (event.sessionUpdate === 'session_info_update') {
      if (event.phase === 'started') {
        get().notifyChatStarted(recordKey);
      }
      if (event.phase === 'final' || event.phase === 'error' || event.phase === 'aborted') {
        get().notifyChatStopped(recordKey);
      }
    }
    if (event.sessionUpdate === 'plan') {
      if (event.taskSnapshot.source === 'todo' || event.taskSnapshot.todos) {
        get().reportTodos(recordKey, event.taskSnapshot.todos ?? []);
      }
      return;
    }
    get().reportSessionSnapshot(event.snapshot, 'replay');
  },

  reportSessionSnapshot: (snapshot, source = 'replay') => {
    void source;
    const recordKey = buildSessionRecordKey(snapshot.catalog.runtimeAddress, snapshot.sessionKey);
    if (snapshot.taskSnapshot?.source === 'todo' || snapshot.taskSnapshot?.todos) {
      get().reportTodos(recordKey, snapshot.taskSnapshot.todos ?? []);
    }
    for (const event of extractSnapshotEventsFromItems(snapshot)) {
      if (event.source === 'todo' || event.todos) {
        get().reportTodos(recordKey, event.todos ?? []);
      }
    }
  },

  getTodoList: (sessionKey) => {
    const snapshot = get().snapshots[sessionKey];
    if (!snapshot) return EMPTY_TODOS;
    return snapshot.todos;
  },

  getTaskDataList: (scopeKey) => {
    const snapshot = get().snapshots[scopeKey];
    if (!snapshot) return EMPTY_TASKS;
    return snapshot.taskDataList;
  },

  getPersistentTaskDataList: (scopeKey) => {
    const snapshot = get().snapshots[scopeKey];
    if (!snapshot) return EMPTY_TASKS;
    return snapshot.tasks;
  },

  getTaskScope: (scopeKey) => get().snapshots[scopeKey]?.scope,

  getSessionTaskScopeKey: (sessionKey) => {
    const normalizedSessionKey = normalizeString(sessionKey);
    return normalizedSessionKey ? taskScopeKeyForSession(normalizedSessionKey) : '';
  },

  getStatusMap: (scopeKey) => get().snapshots[scopeKey]?.statusMap ?? EMPTY_STATUS_MAP,

  getDerivedPlanStatus: (scopeKey) => {
    const snapshot = get().snapshots[scopeKey];
    const tasks = get().getPersistentTaskDataList(scopeKey);
    if (tasks.length === 0) return null;
    if (tasks.every((task) => task.status === 'completed')) {
      return 'finished';
    }
    if (tasks.some((task) => task.status === 'in_progress')) {
      return snapshot?.chatRunning ? 'building' : 'ready';
    }
    return null;
  },

  notifyChatStarted: (sessionKey) => {
    const normalizedSessionKey = normalizeString(sessionKey);
    if (!normalizedSessionKey) return;
    const scopeKey = taskScopeKeyForSession(normalizedSessionKey);
    set((state) => ({
      snapshots: {
        ...state.snapshots,
        [normalizedSessionKey]: updateSnapshot(state.snapshots[normalizedSessionKey], {
          chatRunning: true,
        }),
        ...(scopeKey && scopeKey !== normalizedSessionKey
          ? {
              [scopeKey]: updateSnapshot(state.snapshots[scopeKey], {
                chatRunning: true,
              }),
            }
          : {}),
      },
    }));
  },

  notifyChatStopped: (sessionKey) => {
    const normalizedSessionKey = normalizeString(sessionKey);
    if (!normalizedSessionKey) return;
    const scopeKey = taskScopeKeyForSession(normalizedSessionKey);
    set((state) => ({
      snapshots: {
        ...state.snapshots,
        [normalizedSessionKey]: updateSnapshot(state.snapshots[normalizedSessionKey], {
          chatRunning: false,
        }),
        ...(scopeKey && scopeKey !== normalizedSessionKey
          ? {
              [scopeKey]: updateSnapshot(state.snapshots[scopeKey], {
                chatRunning: false,
              }),
            }
          : {}),
      },
    }));
  },

  reset: (sessionKey) => {
    const normalizedSessionKey = normalizeString(sessionKey);
    if (!normalizedSessionKey) return;
    const scopeKey = taskScopeKeyForSession(normalizedSessionKey);
    set((state) => ({
      snapshots: {
        ...state.snapshots,
        [normalizedSessionKey]: updateSnapshot(undefined, {}),
        ...(scopeKey && scopeKey !== normalizedSessionKey ? { [scopeKey]: updateSnapshot(undefined, {}) } : {}),
      },
    }));
  },

  cleanup: (sessionKey) => {
    const normalizedSessionKey = normalizeString(sessionKey);
    if (!normalizedSessionKey) return;
    const scopeKey = taskScopeKeyForSession(normalizedSessionKey);
    set((state) => {
      const next = { ...state.snapshots };
      delete next[normalizedSessionKey];
      delete next[scopeKey];
      return { snapshots: next };
    });
  },
}));
