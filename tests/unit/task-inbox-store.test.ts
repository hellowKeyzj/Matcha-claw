import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chat';
import type { Task } from '@/services/openclaw/task-manager-client';

const getWorkspaceDirMock = vi.fn<() => Promise<string | null>>();
const getTaskWorkspaceDirsMock = vi.fn<() => Promise<string[]>>();
const getPluginCatalogMock = vi.fn();
const getPluginRuntimeMock = vi.fn();
const listTasksMock = vi.fn<(workspaceDir?: string) => Promise<Task[]>>();
const claimTaskMock = vi.fn();
const sendMessageMock = vi.fn<(message: string) => Promise<void>>();
vi.mock('@/services/openclaw/task-manager-client', () => ({
  getWorkspaceDir: (...args: unknown[]) => getWorkspaceDirMock(...args),
  getTaskWorkspaceDirs: (...args: unknown[]) => getTaskWorkspaceDirsMock(...args),
  listTasks: (...args: unknown[]) => listTasksMock(...args),
  claimTask: (...args: unknown[]) => claimTaskMock(...args),
}));

vi.mock('@/services/openclaw/plugin-manager-client', () => ({
  getPluginCatalog: (...args: unknown[]) => getPluginCatalogMock(...args),
  getPluginRuntime: (...args: unknown[]) => getPluginRuntimeMock(...args),
}));

function task(overrides: Partial<Task>): Task {
  return {
    id: 'task-1',
    subject: 'task',
    description: 'desc',
    status: 'in_progress',
    blockedBy: [],
    blocks: [],
    createdAt: 1,
    updatedAt: 2,
    sessionAffinityKey: 'agent:alpha:main',
    ...overrides,
  };
}

describe('task inbox store', () => {
  beforeEach(async () => {
    getWorkspaceDirMock.mockReset();
    getTaskWorkspaceDirsMock.mockReset();
    getPluginCatalogMock.mockReset();
    getPluginRuntimeMock.mockReset();
    listTasksMock.mockReset();
    claimTaskMock.mockReset();
    sendMessageMock.mockReset();
    sendMessageMock.mockResolvedValue(undefined);
    getPluginCatalogMock.mockResolvedValue({
      plugins: [{ id: 'task-manager', enabled: true, version: '1.0.0' }],
    });
    getPluginRuntimeMock.mockResolvedValue({
      execution: {
        pluginExecutionEnabled: true,
        enabledPluginIds: ['task-manager'],
      },
    });
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      messages: [],
      loadHistory: vi.fn(),
      sendMessage: sendMessageMock,
      sending: false,
      pendingFinal: false,
      activeRunId: null,
    } as never);
  });

  it('init 从 workspace scope 拉取并仅保留未完成任务', async () => {
    getWorkspaceDirMock.mockResolvedValue('E:/workspace/main');
    getTaskWorkspaceDirsMock.mockResolvedValue(['E:/workspace/main']);
    listTasksMock.mockResolvedValue([
      task({ id: 'running', status: 'in_progress' }),
      task({ id: 'pending', status: 'pending' }),
      task({ id: 'done', status: 'completed' }),
    ]);
    const { useTaskInboxStore } = await import('@/stores/task-inbox-store');

    await useTaskInboxStore.getState().init();

    const state = useTaskInboxStore.getState();
    expect(state.initialized).toBe(true);
    expect(state.tasks.map((item) => item.id)).toEqual(['running', 'pending']);
  });

  it('refreshTasks 会同步任务中心最新列表', async () => {
    getWorkspaceDirMock.mockResolvedValue('E:/workspace/main');
    getTaskWorkspaceDirsMock.mockResolvedValue(['E:/workspace/main']);
    listTasksMock
      .mockResolvedValueOnce([task({ id: 'task-2', status: 'pending' })])
      .mockResolvedValueOnce([task({ id: 'task-2', status: 'in_progress' })]);
    const { useTaskInboxStore } = await import('@/stores/task-inbox-store');
    await useTaskInboxStore.getState().init();

    await useTaskInboxStore.getState().refreshTasks();

    expect(useTaskInboxStore.getState().tasks[0]?.status).toBe('in_progress');
  });

  it('openTaskSession 能切换到绑定会话', async () => {
    getWorkspaceDirMock.mockResolvedValue('E:/workspace/main');
    getTaskWorkspaceDirsMock.mockResolvedValue(['E:/workspace/main']);
    listTasksMock.mockResolvedValue([task({ id: 'task-3', sessionAffinityKey: 'agent:beta:main' })]);
    const { useTaskInboxStore } = await import('@/stores/task-inbox-store');
    await useTaskInboxStore.getState().init();

    const result = useTaskInboxStore.getState().openTaskSession('task-3');

    expect(result).toEqual({ switched: true });
    expect(useChatStore.getState().currentSessionKey).toBe('agent:beta:main');
  });

  it('openTaskSession 打开 pending 任务时会尝试自动 claim', async () => {
    getWorkspaceDirMock.mockResolvedValue('E:/workspace/main');
    getTaskWorkspaceDirsMock.mockResolvedValue(['E:/workspace/main']);
    listTasksMock.mockResolvedValue([task({
      id: 'task-4',
      status: 'pending',
      workspaceDir: 'E:/workspace/main',
      sessionAffinityKey: 'agent:beta:main',
    })]);
    claimTaskMock.mockResolvedValue(task({
      id: 'task-4',
      status: 'in_progress',
      owner: 'beta',
      workspaceDir: 'E:/workspace/main',
    }));
    const { useTaskInboxStore } = await import('@/stores/task-inbox-store');
    await useTaskInboxStore.getState().init();

    const result = useTaskInboxStore.getState().openTaskSession('task-4');
    expect(result).toEqual({ switched: true });

    await Promise.resolve();
    await Promise.resolve();

    expect(claimTaskMock).toHaveBeenCalledWith({
      taskId: 'task-4',
      owner: 'beta',
      workspaceDir: 'E:/workspace/main',
      sessionKey: 'agent:beta:main',
    });
  });

  it('auto-claim 成功后会注入任务恢复提示消息', async () => {
    getWorkspaceDirMock.mockResolvedValue('E:/workspace/main');
    getTaskWorkspaceDirsMock.mockResolvedValue(['E:/workspace/main']);
    listTasksMock.mockResolvedValue([task({
      id: 'task-claim-1',
      status: 'pending',
      workspaceDir: 'E:/workspace/main',
      createdAt: 10,
      updatedAt: 10,
      sessionAffinityKey: undefined,
    })]);
    claimTaskMock.mockResolvedValue(task({
      id: 'task-claim-1',
      status: 'in_progress',
      owner: 'main',
      workspaceDir: 'E:/workspace/main',
      createdAt: 10,
      updatedAt: 20,
    }));
    const { useTaskInboxStore } = await import('@/stores/task-inbox-store');

    await useTaskInboxStore.getState().init();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(claimTaskMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock.mock.calls[0]?.[0]).toContain('Task Manager 恢复提示');
    expect(sendMessageMock.mock.calls[0]?.[0]).toContain('task-claim-1');
  });

  it('当前会话已有 in_progress 任务时不再 claim，但会注入恢复提示', async () => {
    getWorkspaceDirMock.mockResolvedValue('E:/workspace/main');
    getTaskWorkspaceDirsMock.mockResolvedValue(['E:/workspace/main']);
    listTasksMock.mockResolvedValue([task({
      id: 'task-active-1',
      status: 'in_progress',
      owner: 'main',
      workspaceDir: 'E:/workspace/main',
      createdAt: 10,
      updatedAt: 30,
      sessionAffinityKey: undefined,
    })]);
    const { useTaskInboxStore } = await import('@/stores/task-inbox-store');

    await useTaskInboxStore.getState().init();
    await Promise.resolve();
    await Promise.resolve();

    expect(claimTaskMock).not.toHaveBeenCalled();
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock.mock.calls[0]?.[0]).toContain('task-active-1');
  });

  it('claim 冲突错误不会写入全局 error', async () => {
    getWorkspaceDirMock.mockResolvedValue('E:/workspace/main');
    getTaskWorkspaceDirsMock.mockResolvedValue(['E:/workspace/main']);
    listTasksMock.mockResolvedValue([task({
      id: 'task-race-1',
      status: 'pending',
      workspaceDir: 'E:/workspace/main',
      createdAt: 10,
      updatedAt: 10,
    })]);
    claimTaskMock.mockRejectedValue(new Error('already_claimed by another session'));
    const { useTaskInboxStore } = await import('@/stores/task-inbox-store');

    await useTaskInboxStore.getState().init();
    await Promise.resolve();
    await Promise.resolve();

    expect(useTaskInboxStore.getState().error).toBeNull();
    expect(sendMessageMock).not.toHaveBeenCalled();
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

  it('workspace scope 为空时仍会调用 task_manager.list 预热上下文', async () => {
    getWorkspaceDirMock.mockResolvedValue(null);
    getTaskWorkspaceDirsMock.mockResolvedValue([]);
    listTasksMock.mockResolvedValue([
      task({ id: 'fallback-1', status: 'pending' }),
    ]);
    const { useTaskInboxStore } = await import('@/stores/task-inbox-store');

    await useTaskInboxStore.getState().init();

    expect(listTasksMock).toHaveBeenCalledWith();
    const state = useTaskInboxStore.getState();
    expect(state.tasks.map((item) => item.id)).toEqual(['fallback-1']);
  });
});
