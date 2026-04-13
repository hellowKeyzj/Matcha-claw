import { create } from 'zustand';
import {
  getWorkspaceDir,
  getTaskWorkspaceDirs,
  listTasks,
  updateTask,
  type Task,
} from '@/services/openclaw/task-manager-client';

interface TaskCenterState {
  tasks: Task[];
  snapshotReady: boolean;
  initialLoading: boolean;
  refreshing: boolean;
  mutating: boolean;
  initialized: boolean;
  error: string | null;
  workspaceDir: string | null;
  workspaceDirs: string[];
  pluginInstalled: boolean;
  pluginEnabled: boolean;
  pluginVersion?: string;
  init: () => Promise<void>;
  refreshTasks: (options?: { silent?: boolean }) => Promise<void>;
  deleteTaskById: (payload: { taskId: string }) => Promise<void>;
  handleGatewayNotification: (notification: unknown) => void;
}

function patchTask(list: Task[], nextTask: Task | undefined): Task[] {
  if (!nextTask) {
    return list;
  }
  const idx = list.findIndex((row) => row.id === nextTask.id && (row.workspaceDir || '') === (nextTask.workspaceDir || ''));
  if (idx < 0) {
    return [nextTask, ...list];
  }
  const cloned = [...list];
  cloned[idx] = { ...cloned[idx], ...nextTask };
  return cloned;
}

function sortTasksByTime(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const left = typeof a.updatedAt === 'number' ? a.updatedAt : (a.createdAt ?? 0);
    const right = typeof b.updatedAt === 'number' ? b.updatedAt : (b.createdAt ?? 0);
    return right - left;
  });
}

function areTaskListsEquivalent(left: Task[], right: Task[]): boolean {
  if (left === right) {
    return true;
  }
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a.id !== b.id) {
      return false;
    }
    if ((a.workspaceDir || '') !== (b.workspaceDir || '')) {
      return false;
    }
    if (a.status !== b.status) {
      return false;
    }
    if ((a.updatedAt || 0) !== (b.updatedAt || 0)) {
      return false;
    }
  }
  return true;
}

const TASK_CENTER_REFRESH_MIN_GAP_MS = 1_200;
let taskCenterInitPromise: Promise<void> | null = null;
let taskCenterRefreshPromise: Promise<void> | null = null;
let taskCenterLastRefreshAtMs = 0;

function isTaskManagerUnavailableError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  const referencesTaskManager = message.includes('task_manager') || message.includes('task-manager');
  if (!referencesTaskManager) {
    return false;
  }
  return (
    message.includes('not found')
    || message.includes('unknown')
    || message.includes('unsupported')
    || message.includes('disabled')
    || message.includes('not enabled')
    || message.includes('unavailable')
  );
}

async function listTasksFromWorkspaceScope(scope: string[]): Promise<Task[]> {
  if (scope.length === 0) {
    const single = await listTasks();
    return sortTasksByTime(single);
  }

  const results = await Promise.allSettled(
    scope.map(async (workspaceDir) => {
      const tasks = await listTasks(workspaceDir);
      return tasks.map((task) => ({ ...task, workspaceDir }));
    }),
  );

  const merged = new Map<string, Task>();
  let fulfilledCount = 0;
  let firstError: unknown = null;
  for (const item of results) {
    if (item.status !== 'fulfilled') {
      if (firstError == null) {
        firstError = item.reason;
      }
      continue;
    }
    fulfilledCount += 1;
    for (const task of item.value) {
      const key = `${task.id}@@${task.workspaceDir || ''}`;
      merged.set(key, task);
    }
  }

  if (scope.length > 0 && fulfilledCount === 0) {
    if (firstError instanceof Error) {
      throw firstError;
    }
    throw new Error(firstError ? String(firstError) : 'Failed to load tasks from workspace scope');
  }

  return sortTasksByTime(Array.from(merged.values()));
}

export const useTaskCenterStore = create<TaskCenterState>((set, get) => ({
  tasks: [],
  snapshotReady: false,
  initialLoading: false,
  refreshing: false,
  mutating: false,
  initialized: false,
  error: null,
  workspaceDir: null,
  workspaceDirs: [],
  pluginInstalled: false,
  pluginEnabled: false,
  pluginVersion: undefined,

  init: async () => {
    if (taskCenterInitPromise) {
      await taskCenterInitPromise;
      return;
    }
    const hasSnapshot = get().snapshotReady;
    if (hasSnapshot) {
      set({ refreshing: true, initialLoading: false, error: null });
    } else {
      set({ initialLoading: true, refreshing: false, error: null });
    }

    const task = (async () => {
      let scope: string[] = [];
      let workspaceLabel: string | null = null;
      try {
        const workspaceDirs = await getTaskWorkspaceDirs();
        const workspace = workspaceDirs.length === 0
          ? await getWorkspaceDir()
          : null;
        scope = workspaceDirs.length > 0
          ? workspaceDirs
          : (workspace ? [workspace] : []);
        workspaceLabel = scope.length <= 1
          ? (scope[0] || workspace)
          : `${scope[0]} (+${scope.length - 1})`;

        set({
          workspaceDir: workspaceLabel || null,
          workspaceDirs: scope,
          pluginInstalled: true,
          pluginEnabled: true,
          pluginVersion: undefined,
          snapshotReady: true,
          initialized: true,
          initialLoading: false,
          refreshing: true,
          error: null,
        });

        const tasks = await listTasksFromWorkspaceScope(scope);
        set((state) => {
          if (areTaskListsEquivalent(state.tasks, tasks)) {
            return {
              ...state,
              refreshing: false,
              error: null,
            };
          }
          return {
            ...state,
            tasks,
            refreshing: false,
            error: null,
          };
        });
      } catch (error) {
        if (isTaskManagerUnavailableError(error)) {
          set({
            workspaceDir: workspaceLabel,
            workspaceDirs: scope,
            tasks: [],
            pluginInstalled: false,
            pluginEnabled: false,
            pluginVersion: undefined,
            snapshotReady: true,
            initialized: true,
            initialLoading: false,
            refreshing: false,
            error: null,
          });
          return;
        }
        set({
          snapshotReady: true,
          initialized: true,
          initialLoading: false,
          refreshing: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();

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
    const silent = options?.silent === true;
    if (!get().snapshotReady) {
      await get().init();
      return;
    }
    if (taskCenterInitPromise) {
      await taskCenterInitPromise;
      return;
    }
    if (!get().pluginInstalled || !get().pluginEnabled) {
      set({ refreshing: false, initialLoading: false, error: null, tasks: [] });
      taskCenterLastRefreshAtMs = Date.now();
      return;
    }
    if (taskCenterRefreshPromise) {
      await taskCenterRefreshPromise;
      return;
    }
    if (Date.now() - taskCenterLastRefreshAtMs < TASK_CENTER_REFRESH_MIN_GAP_MS) {
      return;
    }
    if (!silent) {
      set({ refreshing: true, initialLoading: false, error: null });
    }
    taskCenterRefreshPromise = (async () => {
      try {
        const tasks = await listTasksFromWorkspaceScope(get().workspaceDirs);
        set((state) => {
          if (areTaskListsEquivalent(state.tasks, tasks)) {
            return {
              ...state,
              refreshing: false,
              error: null,
            };
          }
          return {
            ...state,
            tasks,
            refreshing: false,
            error: null,
          };
        });
      } catch (error) {
        set({
          refreshing: false,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        taskCenterLastRefreshAtMs = Date.now();
      }
    })();
    try {
      await taskCenterRefreshPromise;
    } finally {
      taskCenterRefreshPromise = null;
    }
  },

  deleteTaskById: async ({ taskId }) => {
    if (!taskId) {
      return;
    }
    set({ mutating: true, error: null });
    try {
      const taskWorkspace = get().tasks.find((row) => row.id === taskId)?.workspaceDir;
      await updateTask({
        taskId,
        status: 'completed',
        ...(typeof taskWorkspace === 'string' && taskWorkspace.trim().length > 0
          ? { workspaceDir: taskWorkspace }
          : {}),
      });
      set((state) => ({
        tasks: state.tasks.map((task) => task.id === taskId ? { ...task, status: 'completed' } : task),
      }));
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ mutating: false });
    }
  },

  handleGatewayNotification: (notification: unknown) => {
    if (!notification || typeof notification !== 'object') {
      return;
    }
    const payload = notification as { method?: unknown; params?: unknown };
    if (typeof payload.method !== 'string') {
      return;
    }
    const params = (payload.params && typeof payload.params === 'object') ? payload.params as Record<string, unknown> : {};
    const task = params.task as Task | undefined;

    if (task) {
      set((state) => ({
        tasks: patchTask(state.tasks, task),
      }));
      return;
    }

    if (payload.method === 'task_deleted' || payload.method === 'task_manager.deleted') {
      const taskId = typeof params.taskId === 'string' ? params.taskId : '';
      if (!taskId) {
        return;
      }
      set((state) => ({
        tasks: state.tasks.filter((row) => row.id !== taskId),
      }));
    }
  },
}));
