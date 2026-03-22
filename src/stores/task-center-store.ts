import { create } from 'zustand';
import {
  deleteTask,
  getWorkspaceDir,
  getTaskWorkspaceDirs,
  getTaskPluginStatus,
  installTaskPlugin,
  listTasks,
  resumeTask,
  type Task,
  wakeTaskSession,
} from '@/services/openclaw/task-manager-client';
import { inferInputModeFromPrompt } from '@/lib/task-inbox';

interface BlockedTaskItem {
  taskId: string;
  confirmId: string;
  prompt: string;
  type: 'waiting_for_input' | 'waiting_approval';
  inputMode: 'decision' | 'free_text';
}

interface TaskCenterState {
  tasks: Task[];
  loading: boolean;
  initialized: boolean;
  error: string | null;
  workspaceDir: string | null;
  workspaceDirs: string[];
  pluginInstalled: boolean;
  pluginEnabled: boolean;
  pluginVersion?: string;
  blockedQueue: BlockedTaskItem[];
  init: () => Promise<void>;
  refreshTasks: () => Promise<void>;
  installPlugin: () => Promise<void>;
  resumeBlockedTask: (payload: {
    taskId: string;
    confirmId: string;
    decision?: 'approve' | 'reject';
    userInput?: string;
  }) => Promise<void>;
  deleteTaskById: (payload: { taskId: string }) => Promise<void>;
  closeBlockedDialog: (payload: { taskId: string; confirmId: string }) => void;
  handleGatewayNotification: (notification: unknown) => void;
}

function patchTask(list: Task[], nextTask: Task | undefined): Task[] {
  if (!nextTask) {
    return list;
  }
  const idx = list.findIndex((row) => row.id === nextTask.id);
  if (idx < 0) {
    return [nextTask, ...list];
  }
  const cloned = [...list];
  cloned[idx] = { ...cloned[idx], ...nextTask };
  return cloned;
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

function areBlockedQueuesEquivalent(left: BlockedTaskItem[], right: BlockedTaskItem[]): boolean {
  if (left === right) {
    return true;
  }
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (
      a.taskId !== b.taskId
      || a.confirmId !== b.confirmId
      || a.prompt !== b.prompt
      || a.type !== b.type
      || a.inputMode !== b.inputMode
    ) {
      return false;
    }
  }
  return true;
}

function resolveBlockedInputMode(input: {
  inputMode?: unknown;
  prompt: string;
  task?: Task;
}): 'decision' | 'free_text' {
  const fromEvent = input.inputMode === 'decision' || input.inputMode === 'free_text'
    ? input.inputMode
    : undefined;
  if (fromEvent) {
    return fromEvent;
  }
  const fromTask = input.task?.blocked_info?.input_mode;
  if (fromTask === 'decision' || fromTask === 'free_text') {
    return fromTask;
  }
  return inferInputModeFromPrompt(input.prompt);
}

function extractBlockedTaskFromTask(task: Task): BlockedTaskItem | null {
  if (task.status !== 'waiting_for_input' && task.status !== 'waiting_approval') {
    return null;
  }
  const confirmId = typeof task.blocked_info?.confirm_id === 'string' ? task.blocked_info.confirm_id.trim() : '';
  if (!confirmId) {
    return null;
  }
  const question = typeof task.blocked_info?.question === 'string' ? task.blocked_info.question.trim() : '';
  const description = typeof task.blocked_info?.description === 'string' ? task.blocked_info.description.trim() : '';
  const prompt = question || description;
  if (!prompt) {
    return null;
  }
  return {
    taskId: task.id,
    confirmId,
    prompt,
    type: task.status,
    inputMode: resolveBlockedInputMode({
      prompt,
      task,
    }),
  };
}

function collectBlockedQueueFromTasks(tasks: Task[]): BlockedTaskItem[] {
  return tasks
    .map((task) => extractBlockedTaskFromTask(task))
    .filter((item): item is BlockedTaskItem => item !== null);
}

function upsertBlockedTask(queue: BlockedTaskItem[], nextItem: BlockedTaskItem): BlockedTaskItem[] {
  const filtered = queue.filter((row) => row.taskId !== nextItem.taskId);
  return [...filtered, nextItem];
}

function removeBlockedTask(queue: BlockedTaskItem[], taskId: string): BlockedTaskItem[] {
  return queue.filter((row) => row.taskId !== taskId);
}

function shouldAutoWakeByResumeReason(reason: string): boolean {
  return reason === 'task_created'
    || reason === 'tool_resume'
    || reason === 'user_input'
    || reason === 'approval_webhook';
}

const TASK_CENTER_REFRESH_MIN_GAP_MS = 1_200;
let taskCenterRefreshPromise: Promise<void> | null = null;
let taskCenterLastRefreshAtMs = 0;

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
  for (const item of results) {
    if (item.status !== 'fulfilled') {
      continue;
    }
    for (const task of item.value) {
      const key = `${task.id}@@${task.workspaceDir || ''}`;
      merged.set(key, task);
    }
  }

  return sortTasksByTime(Array.from(merged.values()));
}

export const useTaskCenterStore = create<TaskCenterState>((set, get) => ({
  tasks: [],
  loading: false,
  initialized: false,
  error: null,
  workspaceDir: null,
  workspaceDirs: [],
  pluginInstalled: false,
  pluginEnabled: false,
  pluginVersion: undefined,
  blockedQueue: [],

  init: async () => {
    if (get().loading) {
      return;
    }
    set({ loading: true, error: null });
    try {
      const [workspace, workspaceDirs, pluginStatus] = await Promise.all([
        getWorkspaceDir(),
        getTaskWorkspaceDirs(),
        getTaskPluginStatus(),
      ]);
      const scope = workspaceDirs.length > 0
        ? workspaceDirs
        : (workspace ? [workspace] : []);
      const workspaceLabel = scope.length <= 1
        ? (scope[0] || workspace)
        : `${scope[0]} (+${scope.length - 1})`;
      set({
        workspaceDir: workspaceLabel || null,
        workspaceDirs: scope,
        pluginInstalled: pluginStatus.installed,
        pluginEnabled: pluginStatus.enabled && pluginStatus.skillEnabled,
        pluginVersion: pluginStatus.version,
      });

      if (pluginStatus.installed && pluginStatus.enabled) {
        const tasks = await listTasksFromWorkspaceScope(scope);
        set({
          tasks,
          blockedQueue: collectBlockedQueueFromTasks(tasks),
        });
      } else {
        set({ tasks: [], blockedQueue: [] });
      }
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ loading: false, initialized: true });
    }
  },

  refreshTasks: async () => {
    if (taskCenterRefreshPromise) {
      await taskCenterRefreshPromise;
      return;
    }
    if (Date.now() - taskCenterLastRefreshAtMs < TASK_CENTER_REFRESH_MIN_GAP_MS) {
      return;
    }
    if (get().loading) {
      return;
    }
    taskCenterRefreshPromise = (async () => {
      try {
        const tasks = await listTasksFromWorkspaceScope(get().workspaceDirs);
        const nextBlockedQueue = collectBlockedQueueFromTasks(tasks);
        set((state) => {
          if (
            areTaskListsEquivalent(state.tasks, tasks)
            && areBlockedQueuesEquivalent(state.blockedQueue, nextBlockedQueue)
          ) {
            return state;
          }
          return {
            ...state,
            tasks,
            blockedQueue: nextBlockedQueue,
          };
        });
      } catch (error) {
        set({ error: error instanceof Error ? error.message : String(error) });
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

  installPlugin: async () => {
    set({ loading: true, error: null });
    try {
      const result = await installTaskPlugin();
      if (!result.success) {
        throw new Error(result.error || 'install failed');
      }
      const status = await getTaskPluginStatus();
      set({
        pluginInstalled: status.installed,
        pluginEnabled: status.enabled && status.skillEnabled,
        pluginVersion: status.version,
      });

      if (status.installed && status.enabled) {
        const tasks = await listTasksFromWorkspaceScope(get().workspaceDirs);
        set({
          tasks,
          blockedQueue: collectBlockedQueueFromTasks(tasks),
        });
      }
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ loading: false });
    }
  },

  resumeBlockedTask: async ({ taskId, confirmId, decision, userInput }) => {
    if (!taskId || !confirmId) {
      return;
    }
    set({ loading: true, error: null });
    try {
      const taskWorkspace = get().tasks.find((row) => row.id === taskId)?.workspaceDir;
      const task = await resumeTask(taskId, {
        confirmId,
        ...(decision ? { decision } : {}),
        ...(typeof userInput === 'string' ? { userInput } : {}),
        workspaceDir: typeof taskWorkspace === 'string' && taskWorkspace.trim().length > 0
          ? taskWorkspace
          : undefined,
      });
      set((state) => ({
        tasks: patchTask(state.tasks, task),
        blockedQueue: removeBlockedTask(state.blockedQueue, task.id),
      }));
      await wakeTaskSession(taskId, {
        message: userInput ?? decision,
        assignedSession: task.assigned_session,
      });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ loading: false });
    }
  },

  deleteTaskById: async ({ taskId }) => {
    if (!taskId) {
      return;
    }
    set({ loading: true, error: null });
    try {
      const taskWorkspace = get().tasks.find((row) => row.id === taskId)?.workspaceDir;
      await deleteTask(taskId, {
        workspaceDir: typeof taskWorkspace === 'string' && taskWorkspace.trim().length > 0
          ? taskWorkspace
          : undefined,
      });
      set((state) => ({
        tasks: state.tasks.filter((task) => task.id !== taskId),
        blockedQueue: removeBlockedTask(state.blockedQueue, taskId),
      }));
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ loading: false });
    }
  },

  closeBlockedDialog: ({ taskId, confirmId }) => {
    if (!taskId || !confirmId) {
      return;
    }
    set((state) => ({
      blockedQueue: state.blockedQueue.filter((item) => !(item.taskId === taskId && item.confirmId === confirmId)),
    }));
  },

  handleGatewayNotification: (notification: unknown) => {
    if (!notification || typeof notification !== 'object') {
      return;
    }
    const payload = notification as { method?: unknown; params?: unknown };
    if (typeof payload.method !== 'string' || !payload.method.startsWith('task_')) {
      return;
    }
    const params = (payload.params && typeof payload.params === 'object') ? payload.params as Record<string, unknown> : {};

    if (payload.method === 'task_progress_update' || payload.method === 'task_status_changed') {
      const task = params.task as Task | undefined;
      if (task) {
        const blocked = extractBlockedTaskFromTask(task);
        set((state) => ({
          tasks: patchTask(state.tasks, task),
          blockedQueue: blocked
            ? upsertBlockedTask(state.blockedQueue, blocked)
            : removeBlockedTask(state.blockedQueue, task.id),
        }));
      }
      return;
    }

    if (payload.method === 'task_blocked') {
      const task = params.task as Task | undefined;
      const taskId = typeof params.taskId === 'string' ? params.taskId : task?.id;
      const confirmId = typeof params.confirmId === 'string'
        ? params.confirmId
        : (typeof task?.blocked_info?.confirm_id === 'string' ? task.blocked_info.confirm_id : '');
      const prompt = typeof params.question === 'string'
        ? params.question
        : (typeof params.description === 'string'
          ? params.description
          : (typeof task?.blocked_info?.question === 'string'
            ? task.blocked_info.question
            : (typeof task?.blocked_info?.description === 'string' ? task.blocked_info.description : '')));
      const blockedType = params.type === 'waiting_approval' ? 'waiting_approval' : 'waiting_for_input';
      if (task) {
        set((state) => ({ tasks: patchTask(state.tasks, task) }));
      }
      if (taskId && confirmId && prompt) {
        set((state) => ({
          blockedQueue: upsertBlockedTask(state.blockedQueue, {
            taskId,
            confirmId,
            prompt,
            type: blockedType,
            inputMode: resolveBlockedInputMode({
              inputMode: params.inputMode,
              prompt,
              task,
            }),
          }),
        }));
      }
      return;
    }

    if (payload.method === 'task_needs_resume') {
      const task = params.task as Task | undefined;
      const taskId = typeof params.taskId === 'string' ? params.taskId : task?.id;
      const resumeReason = typeof params.resumeReason === 'string' ? params.resumeReason : '';
      const userInput = typeof params.userInput === 'string' ? params.userInput : undefined;
      if (task) {
        set((state) => ({
          tasks: patchTask(state.tasks, task),
          blockedQueue: removeBlockedTask(state.blockedQueue, task.id),
        }));
      }
      if (taskId) {
        set((state) => ({
          blockedQueue: removeBlockedTask(state.blockedQueue, taskId),
        }));
        if (shouldAutoWakeByResumeReason(resumeReason)) {
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
      }
      return;
    }

    if (payload.method === 'task_deleted') {
      const taskId = typeof params.taskId === 'string' ? params.taskId : '';
      if (!taskId) {
        return;
      }
      set((state) => ({
        tasks: state.tasks.filter((task) => task.id !== taskId),
        blockedQueue: removeBlockedTask(state.blockedQueue, taskId),
      }));
      return;
    }

    const task = params.task as Task | undefined;
    if (task) {
      const blocked = extractBlockedTaskFromTask(task);
      set((state) => ({
        tasks: patchTask(state.tasks, task),
        blockedQueue: blocked
          ? upsertBlockedTask(state.blockedQueue, blocked)
          : removeBlockedTask(state.blockedQueue, task.id),
      }));
    }
  },
}));
