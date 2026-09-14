import { create } from 'zustand';
import type {
  SessionIdentity,
} from '../../electron/desktop-contract/runtime-address';
import {
  isTaskManagementAvailable,
  listTaskSnapshot,
  updateTask,
  type TaskListSnapshot,
  type TaskScope,
} from '@/services/openclaw/task-manager-client';
import { useTaskSnapshotStore } from '@/stores/chat/task-snapshot-store';
import { logRendererDebug } from '@/lib/debug-logging';

interface TaskCenterState {
  sessionKey: string | null;
  sessionIdentity: SessionIdentity | null;
  selectedScopeKey: string | null;
  selectedScope: TaskScope | null;
  initialLoading: boolean;
  refreshing: boolean;
  mutating: boolean;
  initialized: boolean;
  error: string | null;
  init: (session?: { recordKey: string; sessionIdentity: SessionIdentity }) => Promise<void>;
  refreshTasks: (options?: { sessionKey?: string; sessionIdentity?: SessionIdentity; teamKey?: string; silent?: boolean }) => Promise<void>;
  deleteTaskById: (payload: { taskId: string; sessionKey?: string; sessionIdentity?: SessionIdentity; teamKey?: string }) => Promise<void>;
  clearError: () => void;
}

const taskCenterInitPromises = new Map<string, Promise<void>>();
const taskCenterRefreshPromises = new Map<string, Promise<void>>();

function logTaskPipeline(event: string, payload: Record<string, unknown>): void {
  logRendererDebug(`[task-pipeline] task-center.${event}`, payload);
}

function scopeKeyForSession(sessionKey: string): string {
  return sessionKey;
}

function scopeKeyForOptions(sessionKey: string, teamKey?: string): string {
  return teamKey && teamKey.trim().length > 0 ? `team:${teamKey.trim()}` : scopeKeyForSession(sessionKey);
}

function taskScopeForOptions(sessionKey: string, sessionIdentity: SessionIdentity, teamKey?: string): TaskScope {
  const normalizedTeamKey = teamKey?.trim();
  if (normalizedTeamKey) {
    return {
      type: 'team',
      key: `team:${normalizedTeamKey}`,
      label: `Team · ${normalizedTeamKey}`,
      teamKey: normalizedTeamKey,
    };
  }
  return {
    type: 'session',
    key: scopeKeyForSession(sessionKey),
    label: sessionIdentity.sessionKey,
    sessionKey: sessionIdentity.sessionKey,
    agentId: sessionIdentity.agentId,
  };
}

function reportTaskCenterSnapshot(sessionKey: string, sessionIdentity: SessionIdentity, snapshot: TaskListSnapshot): void {
  useTaskSnapshotStore.getState().reportTaskCenterSnapshot({
    sessionKey: sessionIdentity.sessionKey,
    recordKey: sessionKey,
    ...(snapshot.scope ? { scope: snapshot.scope } : {}),
    tasks: snapshot.tasks,
    todos: snapshot.todos,
    source: 'replay',
  });
}

function reportEmptyTaskSnapshot(sessionKey: string, sessionIdentity: SessionIdentity, teamKey?: string): TaskScope {
  const scope = taskScopeForOptions(sessionKey, sessionIdentity, teamKey);
  reportTaskCenterSnapshot(sessionKey, sessionIdentity, {
    scope,
    tasks: [],
    todos: [],
  });
  return scope;
}

export const useTaskCenterStore = create<TaskCenterState>((set, get) => ({
  sessionKey: null,
  sessionIdentity: null,
  selectedScopeKey: null,
  selectedScope: null,
  initialLoading: false,
  refreshing: false,
  mutating: false,
  initialized: false,
  error: null,

  init: async (session) => {
    const resolvedSessionKey = typeof session?.recordKey === 'string' && session.recordKey.trim().length > 0
      ? session.recordKey.trim()
      : get().sessionKey;
    const sessionIdentity = session?.sessionIdentity ?? get().sessionIdentity;
    if (!resolvedSessionKey || !sessionIdentity) {
      set({
        sessionKey: null,
        sessionIdentity: null,
        selectedScopeKey: null,
        selectedScope: null,
        initialized: true,
        initialLoading: false,
        refreshing: false,
        error: null,
      });
      return;
    }
    const pendingInit = taskCenterInitPromises.get(scopeKeyForSession(resolvedSessionKey));
    if (pendingInit) {
      await pendingInit;
      return;
    }
    set({
      sessionKey: resolvedSessionKey,
      sessionIdentity,
      selectedScopeKey: scopeKeyForSession(resolvedSessionKey),
      initialLoading: true,
      refreshing: false,
      error: null,
    });
    const task = get().refreshTasks({ sessionKey: resolvedSessionKey, sessionIdentity, silent: true })
      .finally(() => {
        if (get().sessionKey === resolvedSessionKey) {
          set({ initialized: true, initialLoading: false });
        }
      });
    taskCenterInitPromises.set(scopeKeyForSession(resolvedSessionKey), task);
    try {
      await task;
    } finally {
      if (taskCenterInitPromises.get(scopeKeyForSession(resolvedSessionKey)) === task) {
        taskCenterInitPromises.delete(scopeKeyForSession(resolvedSessionKey));
      }
    }
  },

  refreshTasks: async (options) => {
    const resolvedSessionKey = typeof options?.sessionKey === 'string' && options.sessionKey.trim().length > 0
      ? options.sessionKey.trim()
      : get().sessionKey;
    if (!resolvedSessionKey) {
      set({ sessionKey: null, sessionIdentity: null, selectedScopeKey: null, selectedScope: null, refreshing: false, error: null });
      return;
    }
    const sessionIdentity = options?.sessionIdentity ?? get().sessionIdentity;
    if (!sessionIdentity) {
      set({ sessionKey: resolvedSessionKey, sessionIdentity: null, selectedScopeKey: null, selectedScope: null, refreshing: false, error: 'SessionIdentity is required' });
      return;
    }
    const teamKey = typeof options?.teamKey === 'string' && options.teamKey.trim().length > 0
      ? options.teamKey.trim()
      : undefined;
    const requestedScopeKey = scopeKeyForOptions(resolvedSessionKey, teamKey);
    const pendingRefresh = taskCenterRefreshPromises.get(requestedScopeKey);
    if (pendingRefresh) {
      await pendingRefresh;
      return;
    }
    if (!options?.silent) {
      set({ sessionKey: resolvedSessionKey, sessionIdentity, selectedScopeKey: requestedScopeKey, refreshing: true, error: null });
    } else if (get().sessionKey !== resolvedSessionKey || get().selectedScopeKey !== requestedScopeKey || get().sessionIdentity !== sessionIdentity) {
      set({ sessionKey: resolvedSessionKey, sessionIdentity, selectedScopeKey: requestedScopeKey });
    }
    const task = (async () => {
      try {
        logTaskPipeline('refresh.start', {
          sessionKey: resolvedSessionKey,
          teamKey: teamKey ?? null,
          scopeKey: requestedScopeKey,
          silent: options?.silent === true,
          storeSessionKey: get().sessionKey,
        });
        if (!await isTaskManagementAvailable(sessionIdentity)) {
          const emptyScope = reportEmptyTaskSnapshot(resolvedSessionKey, sessionIdentity, teamKey);
          if (get().sessionKey === resolvedSessionKey && get().selectedScopeKey === requestedScopeKey) {
            set({
              selectedScope: emptyScope,
              refreshing: false,
              error: null,
              initialized: true,
            });
          }
          return;
        }
        const snapshot = await listTaskSnapshot(teamKey
          ? { sessionKey: sessionIdentity.sessionKey, sessionIdentity, teamKey }
          : { sessionKey: sessionIdentity.sessionKey, sessionIdentity });
        const nextScopeKey = snapshot.scope?.key ?? requestedScopeKey;
        logTaskPipeline('refresh.result', {
          sessionKey: resolvedSessionKey,
          scopeKey: nextScopeKey,
          tasksCount: snapshot.tasks.length,
          todosCount: snapshot.todos.length,
        });
        useTaskSnapshotStore.getState().reportTaskCenterSnapshot({
          sessionKey: sessionIdentity.sessionKey,
          recordKey: resolvedSessionKey,
          ...(snapshot.scope ? { scope: snapshot.scope } : {}),
          tasks: snapshot.tasks,
          todos: snapshot.todos,
          source: 'replay',
        });
        if (get().sessionKey === resolvedSessionKey && get().selectedScopeKey === requestedScopeKey) {
          set({
            sessionKey: resolvedSessionKey,
            sessionIdentity,
            selectedScopeKey: nextScopeKey,
            selectedScope: snapshot.scope ?? null,
            refreshing: false,
            error: null,
            initialized: true,
          });
        }
      } catch (error) {
        if (get().sessionKey === resolvedSessionKey && get().selectedScopeKey === requestedScopeKey) {
          set({
            refreshing: false,
            error: error instanceof Error ? error.message : String(error),
            initialized: true,
          });
        }
      }
    })();
    taskCenterRefreshPromises.set(requestedScopeKey, task);
    try {
      await task;
    } finally {
      if (taskCenterRefreshPromises.get(requestedScopeKey) === task) {
        taskCenterRefreshPromises.delete(requestedScopeKey);
      }
    }
  },

  deleteTaskById: async ({ taskId, sessionKey, sessionIdentity, teamKey }) => {
    const resolvedTaskId = typeof taskId === 'string' ? taskId.trim() : '';
    const resolvedSessionKey = typeof sessionKey === 'string' && sessionKey.trim().length > 0
      ? sessionKey.trim()
      : get().sessionKey;
    const resolvedSessionIdentity = sessionIdentity ?? get().sessionIdentity;
    if (!resolvedTaskId || !resolvedSessionKey || !resolvedSessionIdentity) {
      set({ error: 'Task id and session identity are required' });
      return;
    }
    const selectedScope = get().selectedScope;
    const activeTeamKey = teamKey ?? selectedScope?.teamKey;
    set({ mutating: true, error: null });
    try {
      if (!await isTaskManagementAvailable(resolvedSessionIdentity)) {
        set({ error: 'Task management is not available for this session' });
        return;
      }
      const result = await updateTask({
        sessionKey: resolvedSessionIdentity.sessionKey,
        sessionIdentity: resolvedSessionIdentity,
        taskId: resolvedTaskId,
        status: 'deleted',
        ...(activeTeamKey ? { teamKey: activeTeamKey } : {}),
      });
      const refreshOptions = { sessionKey: resolvedSessionKey, sessionIdentity: resolvedSessionIdentity, ...(activeTeamKey ? { teamKey: activeTeamKey } : {}), silent: true };
      if (result.outcome !== 'applied') {
        await get().refreshTasks(refreshOptions);
        set({ error: `Task delete was ${result.outcome}` });
        return;
      }
      reportTaskCenterSnapshot(resolvedSessionKey, resolvedSessionIdentity, result.snapshot);
      await get().refreshTasks(refreshOptions);
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ mutating: false });
    }
  },

  clearError: () => set({ error: null }),
}));
