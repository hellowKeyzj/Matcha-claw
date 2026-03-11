import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chat';
import type { Task } from '@/lib/openclaw/task-manager-client';

const getWorkspaceDirMock = vi.fn<() => Promise<string | null>>();
const getTaskWorkspaceDirsMock = vi.fn<() => Promise<string[]>>();
const listTasksMock = vi.fn<(workspaceDir?: string) => Promise<Task[]>>();
const resumeTaskMock = vi.fn();
const wakeTaskSessionMock = vi.fn();

vi.mock('@/lib/openclaw/task-manager-client', () => ({
  getWorkspaceDir: (...args: unknown[]) => getWorkspaceDirMock(...args),
  getTaskWorkspaceDirs: (...args: unknown[]) => getTaskWorkspaceDirsMock(...args),
  listTasks: (...args: unknown[]) => listTasksMock(...args),
  resumeTask: (...args: unknown[]) => resumeTaskMock(...args),
  wakeTaskSession: (...args: unknown[]) => wakeTaskSessionMock(...args),
}));

function task(overrides: Partial<Task>): Task {
  return {
    id: 'task-1',
    goal: 'goal',
    status: 'running',
    progress: 0.3,
    plan_markdown: '- [ ] step',
    assigned_session: 'agent:alpha:main',
    created_at: 1,
    updated_at: 2,
    ...overrides,
  };
}

describe('task inbox store', () => {
  beforeEach(async () => {
    getWorkspaceDirMock.mockReset();
    getTaskWorkspaceDirsMock.mockReset();
    listTasksMock.mockReset();
    resumeTaskMock.mockReset();
    wakeTaskSessionMock.mockReset();
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      messages: [],
      loadHistory: vi.fn(),
    } as never);
  });

  it('init 从 workspace scope 拉取并仅保留未完成任务', async () => {
    getWorkspaceDirMock.mockResolvedValue('E:/workspace/main');
    getTaskWorkspaceDirsMock.mockResolvedValue(['E:/workspace/main']);
    listTasksMock.mockResolvedValue([
      task({ id: 'running', status: 'running' }),
      task({ id: 'waiting', status: 'waiting_for_input' }),
      task({ id: 'done', status: 'completed' }),
    ]);
    const { useTaskInboxStore } = await import('@/stores/task-inbox-store');

    await useTaskInboxStore.getState().init();

    const state = useTaskInboxStore.getState();
    expect(state.initialized).toBe(true);
    expect(state.tasks.map((item) => item.id)).toEqual(['running', 'waiting']);
  });

  it('submitDecision 会调用 task_resume + 唤醒会话', async () => {
    getWorkspaceDirMock.mockResolvedValue('E:/workspace/main');
    getTaskWorkspaceDirsMock.mockResolvedValue(['E:/workspace/main']);
    listTasksMock.mockResolvedValue([task({ id: 'task-2', status: 'waiting_for_input' })]);
    resumeTaskMock.mockResolvedValue(task({ id: 'task-2', status: 'running' }));
    wakeTaskSessionMock.mockResolvedValue(undefined);
    const { useTaskInboxStore } = await import('@/stores/task-inbox-store');
    await useTaskInboxStore.getState().init();

    await useTaskInboxStore.getState().submitDecision({
      taskId: 'task-2',
      confirmId: 'confirm-1',
      decision: 'approve',
    });

    expect(resumeTaskMock).toHaveBeenCalled();
    expect(wakeTaskSessionMock).toHaveBeenCalled();
  });

  it('openTaskSession 能切换到绑定会话', async () => {
    getWorkspaceDirMock.mockResolvedValue('E:/workspace/main');
    getTaskWorkspaceDirsMock.mockResolvedValue(['E:/workspace/main']);
    listTasksMock.mockResolvedValue([task({ id: 'task-3', assigned_session: 'agent:beta:main' })]);
    const { useTaskInboxStore } = await import('@/stores/task-inbox-store');
    await useTaskInboxStore.getState().init();

    const result = useTaskInboxStore.getState().openTaskSession('task-3');

    expect(result).toEqual({ switched: true });
    expect(useChatStore.getState().currentSessionKey).toBe('agent:beta:main');
  });

  it('handleGatewayNotification 兼容 task_created 并写入未完成任务', async () => {
    const { useTaskInboxStore } = await import('@/stores/task-inbox-store');

    useTaskInboxStore.getState().handleGatewayNotification({
      method: 'task_created',
      params: {
        task: task({ id: 'task-created-1', status: 'pending' }),
      },
    });

    const state = useTaskInboxStore.getState();
    expect(state.tasks.some((item) => item.id === 'task-created-1')).toBe(true);
  });
});
