import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@/services/openclaw/task-manager-client';

const getWorkspaceDirMock = vi.fn<() => Promise<string | null>>();
const getTaskWorkspaceDirsMock = vi.fn<() => Promise<string[]>>();
const listTasksMock = vi.fn<(workspaceDir?: string) => Promise<Task[]>>();
const updateTaskMock = vi.fn();

vi.mock('@/services/openclaw/task-manager-client', () => ({
  getWorkspaceDir: (...args: unknown[]) => getWorkspaceDirMock(...args),
  getTaskWorkspaceDirs: (...args: unknown[]) => getTaskWorkspaceDirsMock(...args),
  listTasks: (...args: unknown[]) => listTasksMock(...args),
  updateTask: (...args: unknown[]) => updateTaskMock(...args),
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
    ...overrides,
  };
}

describe('task center store', () => {
  beforeEach(() => {
    vi.resetModules();
    getWorkspaceDirMock.mockReset();
    getTaskWorkspaceDirsMock.mockReset();
    listTasksMock.mockReset();
    updateTaskMock.mockReset();
  });

  it('init 在插件可用时加载任务列表', async () => {
    getWorkspaceDirMock.mockResolvedValue('E:/workspace/main');
    getTaskWorkspaceDirsMock.mockResolvedValue(['E:/workspace/main']);
    listTasksMock.mockResolvedValue([
      task({ id: 'pending-1', status: 'pending' }),
      task({ id: 'running-1', status: 'in_progress' }),
    ]);
    const { useTaskCenterStore } = await import('@/stores/task-center-store');

    await useTaskCenterStore.getState().init();

    const state = useTaskCenterStore.getState();
    expect(state.pluginInstalled).toBe(true);
    expect(state.pluginEnabled).toBe(true);
    expect(state.snapshotReady).toBe(true);
    expect(state.initialLoading).toBe(false);
    expect(state.refreshing).toBe(false);
    expect(state.tasks).toHaveLength(2);
  });

  it('首次 init 进入 initialLoading，完成后不再阻塞', async () => {
    getWorkspaceDirMock.mockResolvedValue('E:/workspace/main');
    getTaskWorkspaceDirsMock.mockResolvedValue(['E:/workspace/main']);
    let resolveListTasks: ((value: Task[]) => void) | null = null;
    listTasksMock.mockReturnValue(new Promise<Task[]>((resolve) => {
      resolveListTasks = resolve;
    }));
    const { useTaskCenterStore } = await import('@/stores/task-center-store');

    const initPromise = useTaskCenterStore.getState().init();
    expect(useTaskCenterStore.getState().initialLoading).toBe(true);
    expect(useTaskCenterStore.getState().refreshing).toBe(false);

    resolveListTasks?.([task({ id: 'task-init-1', status: 'pending' })]);
    await initPromise;

    const state = useTaskCenterStore.getState();
    expect(state.snapshotReady).toBe(true);
    expect(state.initialLoading).toBe(false);
    expect(state.refreshing).toBe(false);
    expect(state.tasks.map((item) => item.id)).toEqual(['task-init-1']);
  });

  it('refreshTasks 会重新拉取 scope 内任务', async () => {
    getWorkspaceDirMock.mockResolvedValue('E:/workspace/main');
    getTaskWorkspaceDirsMock.mockResolvedValue(['E:/workspace/main']);
    listTasksMock
      .mockResolvedValueOnce([task({ id: 'task-1', status: 'pending' })])
      .mockResolvedValueOnce([task({ id: 'task-2', status: 'in_progress' })]);
    const { useTaskCenterStore } = await import('@/stores/task-center-store');
    await useTaskCenterStore.getState().init();

    await useTaskCenterStore.getState().refreshTasks();

    expect(useTaskCenterStore.getState().tasks.map((item) => item.id)).toEqual(['task-2']);
  });

  it('已有快照时 refresh 失败保留旧任务列表', async () => {
    getWorkspaceDirMock.mockResolvedValue('E:/workspace/main');
    getTaskWorkspaceDirsMock.mockResolvedValue(['E:/workspace/main']);
    listTasksMock.mockResolvedValueOnce([task({ id: 'task-keep-1', status: 'pending' })]);
    const { useTaskCenterStore } = await import('@/stores/task-center-store');
    await useTaskCenterStore.getState().init();

    listTasksMock.mockRejectedValueOnce(new Error('refresh failed'));
    await useTaskCenterStore.getState().refreshTasks();

    const state = useTaskCenterStore.getState();
    expect(state.tasks.map((item) => item.id)).toEqual(['task-keep-1']);
    expect(state.refreshing).toBe(false);
    expect(state.initialLoading).toBe(false);
    expect(state.error).toBe('refresh failed');
  });

  it('deleteTaskById 会映射为 updateTask(status=completed)', async () => {
    getWorkspaceDirMock.mockResolvedValue('E:/workspace/main');
    getTaskWorkspaceDirsMock.mockResolvedValue(['E:/workspace/main']);
    listTasksMock.mockResolvedValue([task({ id: 'task-delete-1', status: 'in_progress', workspaceDir: 'E:/workspace/main' })]);
    updateTaskMock.mockResolvedValue({
      task: task({ id: 'task-delete-1', status: 'completed' }),
      updatedFields: ['status'],
      statusChange: { from: 'in_progress', to: 'completed' },
    });
    const { useTaskCenterStore } = await import('@/stores/task-center-store');
    await useTaskCenterStore.getState().init();

    await useTaskCenterStore.getState().deleteTaskById({ taskId: 'task-delete-1' });

    expect(updateTaskMock).toHaveBeenCalledWith({
      taskId: 'task-delete-1',
      status: 'completed',
      workspaceDir: 'E:/workspace/main',
    });
    const state = useTaskCenterStore.getState();
    expect(state.tasks[0]?.status).toBe('completed');
  });

  it('deleteTaskById 期间仅切换 mutating，不触发刷新阻塞', async () => {
    getWorkspaceDirMock.mockResolvedValue('E:/workspace/main');
    getTaskWorkspaceDirsMock.mockResolvedValue(['E:/workspace/main']);
    listTasksMock.mockResolvedValue([task({ id: 'task-delete-2', status: 'in_progress', workspaceDir: 'E:/workspace/main' })]);
    let resolveUpdateTask: (() => void) | null = null;
    updateTaskMock.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        resolveUpdateTask = resolve;
      });
      return {
        task: task({ id: 'task-delete-2', status: 'completed' }),
      };
    });
    const { useTaskCenterStore } = await import('@/stores/task-center-store');
    await useTaskCenterStore.getState().init();

    const deletingPromise = useTaskCenterStore.getState().deleteTaskById({ taskId: 'task-delete-2' });
    expect(useTaskCenterStore.getState().mutating).toBe(true);
    expect(useTaskCenterStore.getState().refreshing).toBe(false);

    resolveUpdateTask?.();
    await deletingPromise;
    expect(useTaskCenterStore.getState().mutating).toBe(false);
  });

  it('handleGatewayNotification 写入 task 更新', async () => {
    const { useTaskCenterStore } = await import('@/stores/task-center-store');

    useTaskCenterStore.getState().handleGatewayNotification({
      method: 'task_manager.updated',
      params: {
        task: task({ id: 'task-created-2', status: 'pending' }),
      },
    });

    const state = useTaskCenterStore.getState();
    expect(state.tasks.some((item) => item.id === 'task-created-2')).toBe(true);
  });

  it('handleGatewayNotification 支持 task_manager.deleted 删除任务', async () => {
    const { useTaskCenterStore } = await import('@/stores/task-center-store');
    useTaskCenterStore.setState({
      tasks: [
        task({ id: 'task-delete-a', status: 'pending' }),
        task({ id: 'task-delete-b', status: 'in_progress' }),
      ],
    } as never);

    useTaskCenterStore.getState().handleGatewayNotification({
      method: 'task_manager.deleted',
      params: { taskId: 'task-delete-a' },
    });

    const state = useTaskCenterStore.getState();
    expect(state.tasks.map((item) => item.id)).toEqual(['task-delete-b']);
  });

  it('task_manager 方法不可用时标记插件不可用且不展示错误', async () => {
    getWorkspaceDirMock.mockResolvedValue('E:/workspace/main');
    getTaskWorkspaceDirsMock.mockResolvedValue(['E:/workspace/main']);
    listTasksMock.mockRejectedValue(new Error('gateway method not found: task_manager.list'));
    const { useTaskCenterStore } = await import('@/stores/task-center-store');

    await useTaskCenterStore.getState().init();

    const state = useTaskCenterStore.getState();
    expect(state.pluginInstalled).toBe(false);
    expect(state.pluginEnabled).toBe(false);
    expect(state.tasks).toEqual([]);
    expect(state.error).toBe(null);
  });
});
