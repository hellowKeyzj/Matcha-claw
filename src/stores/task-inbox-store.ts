import { create } from 'zustand';
import { useChatStore } from '@/stores/chat';
import {
  getTaskWorkspaceDirs,
  getWorkspaceDir,
  listTasks,
  resumeTask,
  type Task,
  wakeTaskSession,
} from '@/lib/openclaw/task-manager-client';
import { filterUnfinishedTasks } from '@/lib/task-inbox';

type OpenTaskSessionResult =
  | { switched: true }
  | { switched: false; reason: 'task_not_found' | 'missing_assigned_session' };

interface TaskInboxState {
  tasks: Task[];
  loading: boolean;
  initialized: boolean;
  error: string | null;
  workspaceDirs: string[];
  workspaceLabel: string | null;
  submittingTaskIds: string[];
  init: () => Promise<void>;
  refreshTasks: () => Promise<void>;
  submitDecision: (payload: { taskId: string; confirmId: string; decision: 'approve' | 'reject' }) => Promise<void>;
  submitFreeText: (payload: { taskId: string; confirmId: string; userInput: string }) => Promise<void>;
  openTaskSession: (taskId: string) => OpenTaskSessionResult;
  handleGatewayNotification: (notification: unknown) => void;
  clearError: () => void;
}

function sortTasksByTime(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const left = typeof a.updated_at === 'number' ? a.updated_at : a.created_at;
    const right = typeof b.updated_at === 'number' ? b.updated_at : b.created_at;
    return right - left;
  });
}

function taskUniqueKey(task: Task): string {
  return `${task.id}@@${task.workspaceDir || ''}`;
}

function mergeTaskList(tasks: Task[]): Task[] {
  const merged = new Map<string, Task>();
  for (const task of tasks) {
    merged.set(taskUniqueKey(task), task);
  }
  return sortTasksByTime(Array.from(merged.values()));
}

function upsertTask(current: Task[], incoming: Task): Task[] {
  const targetIndex = current.findIndex((task) => task.id === incoming.id && task.workspaceDir === incoming.workspaceDir);
  if (targetIndex >= 0) {
    const cloned = [...current];
    cloned[targetIndex] = {
      ...cloned[targetIndex],
      ...incoming,
      workspaceDir: incoming.workspaceDir ?? cloned[targetIndex].workspaceDir,
    };
    return sortTasksByTime(filterUnfinishedTasks(cloned));
  }

  const fallbackIndex = current.findIndex((task) => task.id === incoming.id);
  if (fallbackIndex >= 0) {
    const cloned = [...current];
    cloned[fallbackIndex] = {
      ...cloned[fallbackIndex],
      ...incoming,
      workspaceDir: incoming.workspaceDir ?? cloned[fallbackIndex].workspaceDir,
    };
    return sortTasksByTime(filterUnfinishedTasks(cloned));
  }

  return sortTasksByTime(filterUnfinishedTasks([incoming, ...current]));
}

function removeTaskById(current: Task[], taskId: string): Task[] {
  return current.filter((task) => task.id !== taskId);
}

async function loadWorkspaceScope(): Promise<{ scope: string[]; label: string | null }> {
  const [workspaceDir, workspaceDirs] = await Promise.all([
    getWorkspaceDir(),
    getTaskWorkspaceDirs(),
  ]);
  const scope = workspaceDirs.length > 0
    ? workspaceDirs
    : (workspaceDir ? [workspaceDir] : []);
  const label = scope.length <= 1
    ? (scope[0] || workspaceDir || null)
    : `${scope[0]} (+${scope.length - 1})`;
  return { scope, label };
}

async function listTasksFromWorkspaceScope(scope: string[]): Promise<Task[]> {
  if (scope.length === 0) {
    return [];
  }
  const results = await Promise.allSettled(
    scope.map(async (workspaceDir) => {
      const tasks = await listTasks(workspaceDir);
      return tasks.map((task) => ({ ...task, workspaceDir }));
    }),
  );

  const merged: Task[] = [];
  for (const item of results) {
    if (item.status === 'fulfilled') {
      merged.push(...item.value);
    }
  }
  return sortTasksByTime(filterUnfinishedTasks(mergeTaskList(merged)));
}

function appendSubmittingTaskId(list: string[], taskId: string): string[] {
  if (!taskId || list.includes(taskId)) {
    return list;
  }
  return [...list, taskId];
}

function removeSubmittingTaskId(list: string[], taskId: string): string[] {
  return list.filter((id) => id !== taskId);
}

function extractTaskFromNotification(params: Record<string, unknown>): Task | undefined {
  if (!params.task || typeof params.task !== 'object') {
    return undefined;
  }
  return params.task as Task;
}

export const useTaskInboxStore = create<TaskInboxState>((set, get) => ({
  tasks: [],
  loading: false,
  initialized: false,
  error: null,
  workspaceDirs: [],
  workspaceLabel: null,
  submittingTaskIds: [],

  init: async () => {
    if (get().loading) {
      return;
    }
    set({ loading: true, error: null });
    try {
      const { scope, label } = await loadWorkspaceScope();
      const tasks = await listTasksFromWorkspaceScope(scope);
      set({
        tasks,
        workspaceDirs: scope,
        workspaceLabel: label,
      });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      set({
        loading: false,
        initialized: true,
      });
    }
  },

  refreshTasks: async () => {
    if (get().loading) {
      return;
    }
    set({ loading: true, error: null });
    try {
      const currentScope = get().workspaceDirs;
      const { scope, label } = currentScope.length > 0
        ? { scope: currentScope, label: get().workspaceLabel }
        : await loadWorkspaceScope();
      const tasks = await listTasksFromWorkspaceScope(scope);
      set({
        tasks,
        workspaceDirs: scope,
        workspaceLabel: label,
      });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      set({
        loading: false,
      });
    }
  },

  submitDecision: async ({ taskId, confirmId, decision }) => {
    if (!taskId || !confirmId) {
      return;
    }
    const task = get().tasks.find((row) => row.id === taskId);
    set((state) => ({
      error: null,
      submittingTaskIds: appendSubmittingTaskId(state.submittingTaskIds, taskId),
    }));
    const userInput = decision === 'approve' ? 'yes' : 'no';
    try {
      const resumedTask = await resumeTask(taskId, {
        confirmId,
        decision,
        userInput,
        workspaceDir: task?.workspaceDir,
      });

      set((state) => ({
        tasks: upsertTask(state.tasks, {
          ...resumedTask,
          workspaceDir: resumedTask.workspaceDir ?? task?.workspaceDir,
        }),
      }));

      await wakeTaskSession(taskId, {
        message: userInput,
        assignedSession: resumedTask.assigned_session ?? task?.assigned_session,
      });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      set((state) => ({
        submittingTaskIds: removeSubmittingTaskId(state.submittingTaskIds, taskId),
      }));
    }
  },

  submitFreeText: async ({ taskId, confirmId, userInput }) => {
    if (!taskId || !confirmId || !userInput.trim()) {
      return;
    }
    const task = get().tasks.find((row) => row.id === taskId);
    set((state) => ({
      error: null,
      submittingTaskIds: appendSubmittingTaskId(state.submittingTaskIds, taskId),
    }));
    try {
      const resumedTask = await resumeTask(taskId, {
        confirmId,
        userInput: userInput.trim(),
        workspaceDir: task?.workspaceDir,
      });

      set((state) => ({
        tasks: upsertTask(state.tasks, {
          ...resumedTask,
          workspaceDir: resumedTask.workspaceDir ?? task?.workspaceDir,
        }),
      }));

      await wakeTaskSession(taskId, {
        message: userInput.trim(),
        assignedSession: resumedTask.assigned_session ?? task?.assigned_session,
      });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      set((state) => ({
        submittingTaskIds: removeSubmittingTaskId(state.submittingTaskIds, taskId),
      }));
    }
  },

  openTaskSession: (taskId) => {
    const task = get().tasks.find((row) => row.id === taskId);
    if (!task) {
      return { switched: false, reason: 'task_not_found' as const };
    }
    const assignedSession = typeof task.assigned_session === 'string' ? task.assigned_session.trim() : '';
    if (!assignedSession) {
      return { switched: false, reason: 'missing_assigned_session' as const };
    }
    useChatStore.getState().switchSession(assignedSession);
    return { switched: true as const };
  },

  handleGatewayNotification: (notification) => {
    if (!notification || typeof notification !== 'object') {
      return;
    }

    const payload = notification as { method?: unknown; params?: unknown };
    if (typeof payload.method !== 'string' || !payload.method.startsWith('task_')) {
      return;
    }
    const params = (payload.params && typeof payload.params === 'object')
      ? payload.params as Record<string, unknown>
      : {};

    const task = extractTaskFromNotification(params);

    if (payload.method === 'task_progress_update' || payload.method === 'task_status_changed') {
      if (task) {
        set((state) => ({
          tasks: upsertTask(state.tasks, task),
        }));
      } else if (
        typeof params.taskId === 'string'
        && params.to
        && !['pending', 'running', 'waiting_for_input', 'waiting_approval'].includes(String(params.to))
      ) {
        set((state) => ({
          tasks: removeTaskById(state.tasks, params.taskId as string),
        }));
      }
      return;
    }

    if (payload.method === 'task_blocked') {
      if (task) {
        set((state) => ({
          tasks: upsertTask(state.tasks, task),
        }));
      }
      return;
    }

    if (payload.method === 'task_needs_resume') {
      if (task) {
        set((state) => ({
          tasks: upsertTask(state.tasks, task),
        }));
      }
      return;
    }

    if (task) {
      set((state) => ({
        tasks: upsertTask(state.tasks, task),
      }));
    }
  },

  clearError: () => set({ error: null }),
}));
