import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chat';
import type { Task } from '@/services/openclaw/task-manager-client';

const getWorkspaceDirMock = vi.fn<() => Promise<string | null>>();
const getTaskWorkspaceDirsMock = vi.fn<() => Promise<string[]>>();
const getTaskPluginStatusMock = vi.fn();
const installTaskPluginMock = vi.fn();
const listTasksMock = vi.fn<(workspaceDir?: string) => Promise<Task[]>>();
const resumeTaskMock = vi.fn();
const deleteTaskMock = vi.fn();
const wakeTaskSessionMock = vi.fn();

vi.mock('@/services/openclaw/task-manager-client', () => ({
  getWorkspaceDir: (...args: unknown[]) => getWorkspaceDirMock(...args),
  getTaskWorkspaceDirs: (...args: unknown[]) => getTaskWorkspaceDirsMock(...args),
  getTaskPluginStatus: (...args: unknown[]) => getTaskPluginStatusMock(...args),
  installTaskPlugin: (...args: unknown[]) => installTaskPluginMock(...args),
  listTasks: (...args: unknown[]) => listTasksMock(...args),
  resumeTask: (...args: unknown[]) => resumeTaskMock(...args),
  deleteTask: (...args: unknown[]) => deleteTaskMock(...args),
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
    getTaskPluginStatusMock.mockReset();
    installTaskPluginMock.mockReset();
    listTasksMock.mockReset();
    resumeTaskMock.mockReset();
    deleteTaskMock.mockReset();
    wakeTaskSessionMock.mockReset();
    getTaskPluginStatusMock.mockResolvedValue({
      installed: true,
      enabled: true,
      skillEnabled: true,
      version: '1.0.0',
      pluginDir: 'x',
    });
    installTaskPluginMock.mockResolvedValue({ success: true, installed: true });
    deleteTaskMock.mockResolvedValue({ deleted: true, taskId: 'task-1' });
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

  it('workspace scope 为空时仍会调用 task_list 预热上下文', async () => {
    getWorkspaceDirMock.mockResolvedValue(null);
    getTaskWorkspaceDirsMock.mockResolvedValue([]);
    listTasksMock.mockResolvedValue([
      task({ id: 'fallback-1', status: 'waiting_for_input' }),
    ]);
    const { useTaskInboxStore } = await import('@/stores/task-inbox-store');

    await useTaskInboxStore.getState().init();

    expect(listTasksMock).toHaveBeenCalledWith();
    const state = useTaskInboxStore.getState();
    expect(state.tasks.map((item) => item.id)).toEqual(['fallback-1']);
  });
});
