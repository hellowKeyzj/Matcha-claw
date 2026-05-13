import { create } from 'zustand';
import {
  listTaskSnapshot,
  updateTask,
} from '@/services/openclaw/task-manager-client';
import { useTaskSnapshotStore } from '@/stores/chat/task-snapshot-store';
import { logRendererDebug } from '@/lib/debug-logging';

interface TaskCenterState {
  sessionKey: string | null;
  initialLoading: boolean;
  refreshing: boolean;
  mutating: boolean;
  initialized: boolean;
  error: string | null;
  init: (sessionKey?: string) => Promise<void>;
  refreshTasks: (options?: { sessionKey?: string; silent?: boolean }) => Promise<void>;
  deleteTaskById: (payload: { taskId: string; sessionKey?: string }) => Promise<void>;
  handleGatewayNotification: (notification: unknown) => void;
  clearError: () => void;
}

const taskCenterInitPromises = new Map<string, Promise<void>>();
const taskCenterRefreshPromises = new Map<string, Promise<void>>();

function logTaskPipeline(event: string, payload: Record<string, unknown>): void {
  logRendererDebug(`[task-pipeline] task-center.${event}`, payload);
}

function resolveSessionKey(current: string | null, next?: string): string | null {
  if (typeof next === 'string' && next.trim().length > 0) {
    return next.trim();
  }
  return current;
}

export const useTaskCenterStore = create<TaskCenterState>((set, get) => ({
  sessionKey: null,
  initialLoading: false,
  refreshing: false,
  mutating: false,
  initialized: false,
  error: null,

  init: async (sessionKey) => {
    const resolvedSessionKey = resolveSessionKey(get().sessionKey, sessionKey);
    if (!resolvedSessionKey) {
      set({ initialized: true, initialLoading: false, refreshing: false, error: null });
      return;
    }
    const pendingInit = taskCenterInitPromises.get(resolvedSessionKey);
    if (pendingInit) {
      await pendingInit;
      return;
    }
    set({ sessionKey: resolvedSessionKey, initialLoading: true, refreshing: false, error: null });
    const task = get().refreshTasks({ sessionKey: resolvedSessionKey, silent: true })
      .finally(() => {
        if (get().sessionKey === resolvedSessionKey) {
          set({ initialized: true, initialLoading: false });
        }
      });
    taskCenterInitPromises.set(resolvedSessionKey, task);
    try {
      await task;
    } finally {
      if (taskCenterInitPromises.get(resolvedSessionKey) === task) {
        taskCenterInitPromises.delete(resolvedSessionKey);
      }
    }
  },

  refreshTasks: async (options) => {
    const resolvedSessionKey = resolveSessionKey(get().sessionKey, options?.sessionKey);
    if (!resolvedSessionKey) {
      set({ sessionKey: null, refreshing: false, error: null });
      return;
    }
    const pendingRefresh = taskCenterRefreshPromises.get(resolvedSessionKey);
    if (pendingRefresh) {
      await pendingRefresh;
      return;
    }
    if (!options?.silent) {
      set({ sessionKey: resolvedSessionKey, refreshing: true, error: null });
    } else if (get().sessionKey !== resolvedSessionKey) {
      set({ sessionKey: resolvedSessionKey });
    }
    const task = (async () => {
      try {
        logTaskPipeline('refresh.start', {
          sessionKey: resolvedSessionKey,
          silent: options?.silent === true,
          storeSessionKey: get().sessionKey,
        });
        const snapshot = await listTaskSnapshot(resolvedSessionKey);
        logTaskPipeline('refresh.result', {
          sessionKey: resolvedSessionKey,
          tasksCount: snapshot.tasks.length,
          todosCount: snapshot.todos.length,
        });
        useTaskSnapshotStore.getState().reportSnapshotEvent({
          sessionKey: resolvedSessionKey,
          tasks: snapshot.tasks,
          todos: snapshot.todos,
          source: 'replay',
        });
        if (get().sessionKey === resolvedSessionKey) {
          set({
            sessionKey: resolvedSessionKey,
            refreshing: false,
            error: null,
            initialized: true,
          });
        }
      } catch (error) {
        if (get().sessionKey === resolvedSessionKey) {
          set({
            refreshing: false,
            error: error instanceof Error ? error.message : String(error),
            initialized: true,
          });
        }
      }
    })();
    taskCenterRefreshPromises.set(resolvedSessionKey, task);
    try {
      await task;
    } finally {
      if (taskCenterRefreshPromises.get(resolvedSessionKey) === task) {
        taskCenterRefreshPromises.delete(resolvedSessionKey);
      }
    }
  },

  deleteTaskById: async ({ taskId, sessionKey }) => {
    const resolvedSessionKey = resolveSessionKey(get().sessionKey, sessionKey);
    if (!taskId || !resolvedSessionKey) {
      return;
    }
    set({ mutating: true, error: null });
    try {
      const result = await updateTask({
        sessionKey: resolvedSessionKey,
        taskId,
        status: 'deleted',
      });
      if (result.deleted) {
        useTaskSnapshotStore.getState().reportTaskData(resolvedSessionKey, [], {
          merge: true,
          deletedTaskIds: [taskId],
          source: 'tool',
        });
      }
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ mutating: false });
    }
  },

  handleGatewayNotification: (notification) => {
    const sessionKey = get().sessionKey ?? undefined;
    useTaskSnapshotStore.getState().reportGatewayNotification(notification, sessionKey);
  },

  clearError: () => set({ error: null }),
}));
