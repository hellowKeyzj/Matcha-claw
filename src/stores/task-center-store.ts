import { create } from 'zustand';
import {
  listTaskSnapshot,
  updateTask,
} from '@/services/openclaw/task-manager-client';
import { useTaskSnapshotStore } from '@/stores/chat/task-snapshot-store';

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

let taskCenterInitPromise: Promise<void> | null = null;
let taskCenterRefreshPromise: Promise<void> | null = null;

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
    if (taskCenterInitPromise) {
      await taskCenterInitPromise;
      return;
    }
    set({ sessionKey: resolvedSessionKey, initialLoading: true, refreshing: false, error: null });
    const task = get().refreshTasks({ sessionKey: resolvedSessionKey, silent: true })
      .finally(() => {
        set({ initialized: true, initialLoading: false });
      });
    taskCenterInitPromise = task;
    try {
      await task;
    } finally {
      if (taskCenterInitPromise === task) {
        taskCenterInitPromise = null;
      }
    }
  },

  refreshTasks: async (options) => {
    const resolvedSessionKey = resolveSessionKey(get().sessionKey, options?.sessionKey);
    if (!resolvedSessionKey) {
      set({ sessionKey: null, refreshing: false, error: null });
      return;
    }
    if (taskCenterRefreshPromise) {
      await taskCenterRefreshPromise;
      return;
    }
    if (!options?.silent) {
      set({ refreshing: true, error: null });
    }
    taskCenterRefreshPromise = (async () => {
      try {
        const snapshot = await listTaskSnapshot(resolvedSessionKey);
        useTaskSnapshotStore.getState().reportTaskData(resolvedSessionKey, snapshot.tasks, { source: 'replay' });
        useTaskSnapshotStore.getState().reportTodos(resolvedSessionKey, snapshot.todos);
        set({
          sessionKey: resolvedSessionKey,
          refreshing: false,
          error: null,
          initialized: true,
        });
      } catch (error) {
        set({
          refreshing: false,
          error: error instanceof Error ? error.message : String(error),
          initialized: true,
        });
      }
    })();
    try {
      await taskCenterRefreshPromise;
    } finally {
      taskCenterRefreshPromise = null;
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
