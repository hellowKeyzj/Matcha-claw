import { create } from 'zustand';
import { useChatStore } from '@/stores/chat';
import {
  getTaskWorkspaceDirs,
  getWorkspaceDir,
  listTasks,
  resumeTask,
  type Task,
  wakeTaskSession,
} from '@/services/openclaw/task-manager-client';
import { filterUnfinishedTasks } from '@/lib/task-inbox';

type OpenTaskSessionResult =
  | { switched: true }
  | { switched: false; reason: 'task_not_found' };

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
    if (a.progress !== b.progress) {
      return false;
    }
    if ((a.updated_at || 0) !== (b.updated_at || 0)) {
      return false;
    }
  }
  return true;
}

function areStringListsEquivalent(left: string[], right: string[]): boolean {
  if (left === right) {
    return true;
  }
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
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
    try {
      const tasks = await listTasks();
      return sortTasksByTime(filterUnfinishedTasks(tasks));
    } catch {
      return [];
    }
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

function parseAgentIdFromSessionKey(sessionKey?: string): string | null {
  if (!sessionKey) {
    return null;
  }
  const matched = sessionKey.match(/^agent:([^:]+):/i);
  return matched?.[1] ?? null;
}

function shouldAutoWakeByResumeReason(reason: string): boolean {
  return reason === 'task_created'
    || reason === 'tool_resume'
    || reason === 'user_input'
    || reason === 'approval_webhook';
}

function extractTaskFromNotification(params: Record<string, unknown>): Task | undefined {
  if (!params.task || typeof params.task !== 'object') {
    return undefined;
  }
  return params.task as Task;
}

const TASK_INBOX_REFRESH_MIN_GAP_MS = 1_200;
let taskInboxRefreshPromise: Promise<void> | null = null;
let taskInboxLastRefreshAtMs = 0;

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
    if (taskInboxRefreshPromise) {
      await taskInboxRefreshPromise;
      return;
    }
    if (Date.now() - taskInboxLastRefreshAtMs < TASK_INBOX_REFRESH_MIN_GAP_MS) {
      return;
    }
    if (get().loading) {
      return;
    }
    taskInboxRefreshPromise = (async () => {
      try {
        const currentScope = get().workspaceDirs;
        const { scope, label } = currentScope.length > 0
          ? { scope: currentScope, label: get().workspaceLabel }
          : await loadWorkspaceScope();
        const tasks = await listTasksFromWorkspaceScope(scope);
        set((state) => {
          if (
            areTaskListsEquivalent(state.tasks, tasks)
            && areStringListsEquivalent(state.workspaceDirs, scope)
            && state.workspaceLabel === label
          ) {
            return state;
          }
          return {
            ...state,
            tasks,
            workspaceDirs: scope,
            workspaceLabel: label,
          };
        });
      } catch (error) {
        set({
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        taskInboxLastRefreshAtMs = Date.now();
      }
    })();
    try {
      await taskInboxRefreshPromise;
    } finally {
      taskInboxRefreshPromise = null;
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
    const chatState = useChatStore.getState();
    const fallbackAgentId = parseAgentIdFromSessionKey(chatState.currentSessionKey) ?? 'main';
    const targetSession = assignedSession || `agent:${fallbackAgentId}:main`;
    chatState.switchSession(targetSession);
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
      const resumeReason = typeof params.resumeReason === 'string' ? params.resumeReason : '';
      const taskId = typeof params.taskId === 'string' ? params.taskId : task?.id;
      if (taskId && shouldAutoWakeByResumeReason(resumeReason)) {
        const userInput = typeof params.userInput === 'string' ? params.userInput : undefined;
        const knownTask = task ?? get().tasks.find((row) => row.id === taskId);
        void wakeTaskSession(taskId, {
          message: userInput,
          assignedSession: knownTask?.assigned_session,
        }).catch((error) => {
          set({
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
      return;
    }

    if (payload.method === 'task_deleted') {
      const taskId = typeof params.taskId === 'string' ? params.taskId : '';
      if (!taskId) {
        return;
      }
      set((state) => ({
        tasks: removeTaskById(state.tasks, taskId),
      }));
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
