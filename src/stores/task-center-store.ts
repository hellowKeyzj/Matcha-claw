import { create } from 'zustand';
import {
  buildSessionIdentityKey,
  type SessionIdentity,
} from '../types/desktop/runtime-address';
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
  refreshTasks: (options?: { sessionKey?: string; sessionIdentity?: SessionIdentity; teamKey?: string; silent?: boolean; background?: boolean; invalidate?: boolean }) => Promise<void>;
  deleteTaskById: (payload: { taskId: string; sessionKey?: string; sessionIdentity?: SessionIdentity; teamKey?: string }) => Promise<void>;
  clearError: () => void;
}

const taskCenterInitPromises = new Map<string, Promise<void>>();
const taskCenterRefreshPromises = new Map<string, {
  promise: Promise<TaskListSnapshot | null>;
  dirty: boolean;
}>();

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
    const background = options?.background === true;
    const resolvedSessionKey = options?.sessionKey?.trim() || (background ? null : get().sessionKey);
    const sessionIdentity = options?.sessionIdentity ?? (background ? null : get().sessionIdentity);
    if (!resolvedSessionKey || !sessionIdentity) {
      if (background) throw new Error('SessionIdentity and record key are required');
      set({ sessionKey: resolvedSessionKey, sessionIdentity: null, selectedScopeKey: null, selectedScope: null, refreshing: false, error: resolvedSessionKey ? 'SessionIdentity is required' : null });
      return;
    }
    const teamKey = options?.teamKey?.trim() || undefined;
    const requestedScopeKey = scopeKeyForOptions(resolvedSessionKey, teamKey);
    const identityKey = buildSessionIdentityKey(sessionIdentity);
    const requestKey = JSON.stringify([identityKey, teamKey ?? null]);
    const ownsSelection = () => !background
      && get().sessionKey === resolvedSessionKey
      && get().selectedScopeKey === requestedScopeKey
      && get().sessionIdentity !== null
      && buildSessionIdentityKey(get().sessionIdentity!) === identityKey;
    if (!background) {
      set({
        sessionKey: resolvedSessionKey,
        sessionIdentity,
        selectedScopeKey: requestedScopeKey,
        ...(!options?.silent ? { refreshing: true, error: null } : {}),
      });
    }
    let pending = taskCenterRefreshPromises.get(requestKey);
    if (pending) {
      // A mutation/recovery during a read needs one more read, not a lost invalidation.
      if (options?.invalidate) pending.dirty = true;
    } else {
      const refresh = { promise: Promise.resolve<TaskListSnapshot | null>(null), dirty: false };
      refresh.promise = Promise.resolve().then(async () => {
        try {
          do {
            refresh.dirty = false;
            try {
              logTaskPipeline('refresh.start', { sessionKey: resolvedSessionKey, identityKey, teamKey: teamKey ?? null, background });
              const available = await isTaskManagementAvailable(sessionIdentity);
              const snapshot = available
                ? await listTaskSnapshot({ sessionKey: sessionIdentity.sessionKey, sessionIdentity, ...(teamKey ? { teamKey } : {}) })
                : null;
              // Discard results superseded by a terminal tool change or a new epoch.
              if (refresh.dirty) continue;
              logTaskPipeline(snapshot ? 'refresh.result' : 'refresh.unsupported', {
                sessionKey: resolvedSessionKey,
                identityKey,
                tasksCount: snapshot?.tasks.length,
                todosCount: snapshot?.todos.length,
              });
              return snapshot;
            } catch (error) {
              logTaskPipeline('refresh.failed', { sessionKey: resolvedSessionKey, identityKey, error: error instanceof Error ? error.message : String(error) });
              if (!refresh.dirty) throw error;
            }
          } while (refresh.dirty);
          return null;
        } finally {
          taskCenterRefreshPromises.delete(requestKey);
        }
      });
      taskCenterRefreshPromises.set(requestKey, refresh);
      pending = refresh;
    }
    try {
      const snapshot = await pending.promise;
      if (!snapshot) {
        // Keep the public foreground unsupported behavior; background is not an empty snapshot.
        if (background) return;
        const emptyScope = reportEmptyTaskSnapshot(resolvedSessionKey, sessionIdentity, teamKey);
        if (ownsSelection()) set({ selectedScope: emptyScope, refreshing: false, error: null, initialized: true });
        return;
      }
      reportTaskCenterSnapshot(resolvedSessionKey, sessionIdentity, snapshot);
      if (ownsSelection()) {
        set({
          selectedScopeKey: snapshot.scope?.key ?? requestedScopeKey,
          selectedScope: snapshot.scope ?? null,
          refreshing: false,
          error: null,
          initialized: true,
        });
      }
    } catch (error) {
      if (background) throw error;
      if (ownsSelection()) {
        set({ refreshing: false, error: error instanceof Error ? error.message : String(error), initialized: true });
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
      const refreshOptions = { sessionKey: resolvedSessionKey, sessionIdentity: resolvedSessionIdentity, ...(activeTeamKey ? { teamKey: activeTeamKey } : {}), silent: true, invalidate: true };
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
