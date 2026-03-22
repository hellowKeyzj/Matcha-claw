import { create } from 'zustand';
import { useChatStore } from '@/stores/chat';
import type { Task } from '@/services/openclaw/task-manager-client';
import { filterUnfinishedTasks } from '@/lib/task-inbox';
import { useTaskCenterStore } from '@/stores/task-center-store';

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

function parseAgentIdFromSessionKey(sessionKey?: string): string | null {
  if (!sessionKey) {
    return null;
  }
  const matched = sessionKey.match(/^agent:([^:]+):/i);
  return matched?.[1] ?? null;
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

function mapCenterStateToInbox() {
  const center = useTaskCenterStore.getState();
  return {
    tasks: filterUnfinishedTasks(center.tasks),
    loading: center.loading,
    initialized: center.initialized,
    error: center.error,
    workspaceDirs: center.workspaceDirs,
    workspaceLabel: center.workspaceDir,
  };
}

export const useTaskInboxStore = create<TaskInboxState>((set) => ({
  ...mapCenterStateToInbox(),
  submittingTaskIds: [],

  init: async () => {
    await useTaskCenterStore.getState().init();
    set((state) => ({
      ...state,
      ...mapCenterStateToInbox(),
    }));
  },

  refreshTasks: async () => {
    await useTaskCenterStore.getState().refreshTasks();
    set((state) => ({
      ...state,
      ...mapCenterStateToInbox(),
    }));
  },

  submitDecision: async ({ taskId, confirmId, decision }) => {
    if (!taskId || !confirmId) {
      return;
    }
    set((state) => ({
      error: null,
      submittingTaskIds: appendSubmittingTaskId(state.submittingTaskIds, taskId),
    }));
    try {
      const userInput = decision === 'approve' ? 'yes' : 'no';
      await useTaskCenterStore.getState().resumeBlockedTask({
        taskId,
        confirmId,
        decision,
        userInput,
      });
      set((state) => ({
        ...state,
        ...mapCenterStateToInbox(),
      }));
    } finally {
      set((state) => ({
        ...state,
        submittingTaskIds: removeSubmittingTaskId(state.submittingTaskIds, taskId),
      }));
    }
  },

  submitFreeText: async ({ taskId, confirmId, userInput }) => {
    if (!taskId || !confirmId || !userInput.trim()) {
      return;
    }
    set((state) => ({
      error: null,
      submittingTaskIds: appendSubmittingTaskId(state.submittingTaskIds, taskId),
    }));
    try {
      await useTaskCenterStore.getState().resumeBlockedTask({
        taskId,
        confirmId,
        userInput: userInput.trim(),
      });
      set((state) => ({
        ...state,
        ...mapCenterStateToInbox(),
      }));
    } finally {
      set((state) => ({
        ...state,
        submittingTaskIds: removeSubmittingTaskId(state.submittingTaskIds, taskId),
      }));
    }
  },

  openTaskSession: (taskId) => {
    const task = useTaskInboxStore.getState().tasks.find((row) => row.id === taskId);
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
    useTaskCenterStore.getState().handleGatewayNotification(notification);
    set((state) => ({
      ...state,
      ...mapCenterStateToInbox(),
    }));
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
