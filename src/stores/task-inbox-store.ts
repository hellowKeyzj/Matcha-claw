import { create } from 'zustand';
import { useChatStore } from '@/stores/chat';
import { claimTask, type Task } from '@/services/openclaw/task-manager-client';
import { filterUnfinishedTasks } from '@/lib/task-inbox';
import { useTaskCenterStore } from '@/stores/task-center-store';

type OpenTaskSessionResult =
  | { switched: true }
  | { switched: false; reason: 'task_not_found' };

interface TaskInboxState {
  tasks: Task[];
  initialLoading: boolean;
  refreshing: boolean;
  mutating: boolean;
  loading: boolean;
  initialized: boolean;
  error: string | null;
  workspaceDirs: string[];
  workspaceLabel: string | null;
  init: () => Promise<void>;
  refreshTasks: () => Promise<void>;
  openTaskSession: (taskId: string) => OpenTaskSessionResult;
  handleGatewayNotification: (notification: unknown) => void;
  clearError: () => void;
}

const DEFAULT_TASK_SESSION_KEY = 'agent:main:main';
const NON_FATAL_CLAIM_ERROR_PATTERN = /(already_claimed|blocked|invalid_transition|task_not_found)/i;
let autoClaimPromise: Promise<void> | null = null;
const recoveryPromptFingerprintBySession = new Map<string, string>();

function mapCenterStateToInbox() {
  const center = useTaskCenterStore.getState();
  const loading = center.initialLoading || center.refreshing;
  return {
    tasks: filterUnfinishedTasks(center.tasks),
    initialLoading: center.initialLoading,
    refreshing: center.refreshing,
    mutating: center.mutating,
    loading,
    initialized: center.initialized,
    error: center.error,
    workspaceDirs: center.workspaceDirs,
    workspaceLabel: center.workspaceDir,
  };
}

function currentSessionKey(): string {
  const value = useChatStore.getState().currentSessionKey;
  if (typeof value !== 'string' || value.trim().length === 0) {
    return DEFAULT_TASK_SESSION_KEY;
  }
  return value.trim();
}

function parseOwnerFromSessionKey(sessionKey: string): string {
  const matched = sessionKey.match(/^agent:([^:]+):/i);
  return matched?.[1]?.trim() || 'main';
}

function patchTask(list: Task[], nextTask: Task): Task[] {
  return list.map((row) => {
    if (row.id !== nextTask.id || (row.workspaceDir || '') !== (nextTask.workspaceDir || '')) {
      return row;
    }
    return {
      ...row,
      ...nextTask,
    };
  });
}

function hasUnresolvedBlockers(task: Task, taskById: Map<string, Task>): boolean {
  for (const blockerId of task.blockedBy) {
    const blocker = taskById.get(blockerId);
    if (!blocker) {
      continue;
    }
    if (blocker.status !== 'completed') {
      return true;
    }
  }
  return false;
}

function selectSessionActiveTask(tasks: Task[], sessionKey: string, owner: string): Task | null {
  const matched = tasks.filter((task) =>
    task.status === 'in_progress'
    && (
      (typeof task.sessionAffinityKey === 'string' && task.sessionAffinityKey.trim() === sessionKey)
      || task.owner === owner
    ));
  if (matched.length === 0) {
    return null;
  }
  matched.sort((left, right) => {
    const leftUpdated = left.updatedAt ?? 0;
    const rightUpdated = right.updatedAt ?? 0;
    if (leftUpdated !== rightUpdated) {
      return rightUpdated - leftUpdated;
    }
    return left.id.localeCompare(right.id);
  });
  return matched[0] ?? null;
}

function selectClaimCandidate(tasks: Task[], sessionKey: string, owner: string): Task | null {
  if (selectSessionActiveTask(tasks, sessionKey, owner)) {
    return null;
  }

  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const candidates = tasks.filter((task) => {
    if (task.status !== 'pending') {
      return false;
    }
    if (typeof task.owner === 'string' && task.owner.trim().length > 0 && task.owner.trim() !== owner) {
      return false;
    }
    if (typeof task.sessionAffinityKey === 'string' && task.sessionAffinityKey.trim().length > 0 && task.sessionAffinityKey.trim() !== sessionKey) {
      return false;
    }
    if (hasUnresolvedBlockers(task, taskById)) {
      return false;
    }
    return true;
  });

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((left, right) => {
    const leftCreated = left.createdAt ?? 0;
    const rightCreated = right.createdAt ?? 0;
    if (leftCreated !== rightCreated) {
      return leftCreated - rightCreated;
    }
    return left.id.localeCompare(right.id);
  });
  return candidates[0] ?? null;
}

function isNonFatalClaimError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return NON_FATAL_CLAIM_ERROR_PATTERN.test(message);
}

function buildRecoveryPrompt(task: Task): string {
  const blockedBy = task.blockedBy.length > 0 ? task.blockedBy.join(', ') : 'none';
  const blocks = task.blocks.length > 0 ? task.blocks.join(', ') : 'none';
  return [
    '## Task Manager 恢复提示',
    '',
    '请继续推进以下任务：',
    `- taskId: ${task.id}`,
    `- subject: ${task.subject}`,
    `- status: ${task.status}`,
    `- owner: ${task.owner || 'unassigned'}`,
    `- blockedBy: ${blockedBy}`,
    `- blocks: ${blocks}`,
    '',
    '执行要求：先确认阻塞状态，再给出下一步执行动作，完成后同步任务状态。',
  ].join('\n');
}

async function maybeSendRecoveryPrompt(task: Task, sessionKey: string): Promise<void> {
  const chatState = useChatStore.getState();
  if (chatState.currentSessionKey !== sessionKey) {
    return;
  }
  if (chatState.sending || chatState.pendingFinal || chatState.activeRunId) {
    return;
  }

  const fingerprint = `${sessionKey}::${task.id}::${task.updatedAt}::${task.status}::${task.owner || ''}`;
  if (recoveryPromptFingerprintBySession.get(sessionKey) === fingerprint) {
    return;
  }
  recoveryPromptFingerprintBySession.set(sessionKey, fingerprint);

  try {
    await chatState.sendMessage(buildRecoveryPrompt(task));
  } catch {
    recoveryPromptFingerprintBySession.delete(sessionKey);
  }
}

async function autoClaimForCurrentSession(): Promise<void> {
  if (autoClaimPromise) {
    await autoClaimPromise;
    return;
  }

  autoClaimPromise = (async () => {
    const sessionKey = currentSessionKey();
    const owner = parseOwnerFromSessionKey(sessionKey);

    // Recover session affinity for tasks already owned by current session.
    useTaskCenterStore.setState((state) => {
      let changed = false;
      const nextTasks = state.tasks.map((task) => {
        if (task.status !== 'in_progress' || task.owner !== owner) {
          return task;
        }
        if (typeof task.sessionAffinityKey === 'string' && task.sessionAffinityKey.trim().length > 0) {
          return task;
        }
        changed = true;
        return { ...task, sessionAffinityKey: sessionKey };
      });
      if (!changed) {
        return state;
      }
      return {
        ...state,
        tasks: nextTasks,
      };
    });

    const center = useTaskCenterStore.getState();
    const activeTask = selectSessionActiveTask(center.tasks, sessionKey, owner);
    if (activeTask) {
      await maybeSendRecoveryPrompt(activeTask, sessionKey);
      return;
    }

    const candidate = selectClaimCandidate(center.tasks, sessionKey, owner);
    if (!candidate) {
      return;
    }

    try {
      const claimed = await claimTask({
        taskId: candidate.id,
        owner,
        ...(typeof candidate.workspaceDir === 'string' && candidate.workspaceDir.trim().length > 0
          ? { workspaceDir: candidate.workspaceDir }
          : {}),
        sessionKey,
      });
      if (!claimed || typeof claimed !== 'object') {
        return;
      }
      useTaskCenterStore.setState((state) => ({
        ...state,
        tasks: patchTask(state.tasks, { ...claimed, sessionAffinityKey: sessionKey }),
      }));
      await maybeSendRecoveryPrompt({ ...claimed, sessionAffinityKey: sessionKey }, sessionKey);
    } catch (error) {
      if (isNonFatalClaimError(error)) {
        return;
      }
      useTaskCenterStore.setState({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();

  try {
    await autoClaimPromise;
  } finally {
    autoClaimPromise = null;
  }
}

export const useTaskInboxStore = create<TaskInboxState>((set) => ({
  ...mapCenterStateToInbox(),

  init: async () => {
    await useTaskCenterStore.getState().init();
    set((state) => ({
      ...state,
      ...mapCenterStateToInbox(),
    }));
    void autoClaimForCurrentSession();
  },

  refreshTasks: async () => {
    await useTaskCenterStore.getState().refreshTasks();
    set((state) => ({
      ...state,
      ...mapCenterStateToInbox(),
    }));
    void autoClaimForCurrentSession();
  },

  openTaskSession: (taskId) => {
    const task = useTaskInboxStore.getState().tasks.find((row) => row.id === taskId);
    if (!task) {
      return { switched: false, reason: 'task_not_found' as const };
    }
    const chatState = useChatStore.getState();
    const targetSession = typeof task.sessionAffinityKey === 'string' && task.sessionAffinityKey.trim().length > 0
      ? task.sessionAffinityKey.trim()
      : (chatState.currentSessionKey || 'agent:main:main');
    if (targetSession !== chatState.currentSessionKey) {
      chatState.switchSession(targetSession);
    }

    // Persist session affinity in local state so subsequent "open task" keeps landing on the same session.
    useTaskCenterStore.setState((state) => ({
      ...state,
      tasks: state.tasks.map((row) => row.id === task.id ? { ...row, sessionAffinityKey: targetSession } : row),
    }));
    void autoClaimForCurrentSession();

    return { switched: true as const };
  },

  handleGatewayNotification: (notification) => {
    useTaskCenterStore.getState().handleGatewayNotification(notification);
    set((state) => ({
      ...state,
      ...mapCenterStateToInbox(),
    }));
    void autoClaimForCurrentSession();
  },

  clearError: () => {
    useTaskCenterStore.setState({ error: null });
    set((state) => ({ ...state, error: null }));
  },
}));

useTaskCenterStore.subscribe(() => {
  useTaskInboxStore.setState((state) => ({
    ...state,
    ...mapCenterStateToInbox(),
  }));
});

let lastObservedSessionKey = currentSessionKey();
useChatStore.subscribe((state) => {
  const nextSessionKey = typeof state.currentSessionKey === 'string' && state.currentSessionKey.trim().length > 0
    ? state.currentSessionKey.trim()
    : DEFAULT_TASK_SESSION_KEY;
  if (nextSessionKey === lastObservedSessionKey) {
    return;
  }
  lastObservedSessionKey = nextSessionKey;
  void autoClaimForCurrentSession();
});
