import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task, TaskListSnapshot } from '@/services/openclaw/task-manager-client';

const listTaskSnapshotMock = vi.fn<(sessionKey: string) => Promise<TaskListSnapshot>>();
const updateTaskMock = vi.fn();

vi.mock('@/services/openclaw/task-manager-client', () => ({
  listTaskSnapshot: (...args: [string]) => listTaskSnapshotMock(...args),
  updateTask: (...args: unknown[]) => updateTaskMock(...args),
}));

function task(overrides: Partial<Task>): Task {
  return {
    id: '1',
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

function snapshot(tasks: Task[]): TaskListSnapshot {
  return { tasks, todos: [] };
}

describe('task center store', () => {
  beforeEach(() => {
    vi.resetModules();
    listTaskSnapshotMock.mockReset();
    updateTaskMock.mockReset();
  });

  it('init loads session scoped task snapshot', async () => {
    listTaskSnapshotMock.mockResolvedValue(snapshot([
      task({ id: '2', status: 'pending' }),
      task({ id: '1', status: 'in_progress' }),
    ]));
    const { useTaskCenterStore } = await import('@/stores/task-center-store');

    await useTaskCenterStore.getState().init('agent:main:main');

    const state = useTaskCenterStore.getState();
    const { useTaskSnapshotStore } = await import('@/stores/chat/task-snapshot-store');
    expect(state.sessionKey).toBe('agent:main:main');
    expect(state.initialLoading).toBe(false);
    expect(state.refreshing).toBe(false);
    expect(state.initialized).toBe(true);
    expect(useTaskSnapshotStore.getState().getTaskDataList('agent:main:main').map((item) => item.id)).toEqual(['1', '2']);
    expect(listTaskSnapshotMock).toHaveBeenCalledWith('agent:main:main');
  });

  it('init without session clears tasks and marks initialized', async () => {
    const { useTaskCenterStore } = await import('@/stores/task-center-store');

    await useTaskCenterStore.getState().init();

    const state = useTaskCenterStore.getState();
    expect(state.initialized).toBe(true);
    expect(listTaskSnapshotMock).not.toHaveBeenCalled();
  });

  it('refreshTasks keeps previous snapshot when request fails', async () => {
    listTaskSnapshotMock.mockResolvedValueOnce(snapshot([task({ id: '1', status: 'pending' })]));
    const { useTaskCenterStore } = await import('@/stores/task-center-store');
    await useTaskCenterStore.getState().init('agent:main:main');

    listTaskSnapshotMock.mockRejectedValueOnce(new Error('refresh failed'));
    await useTaskCenterStore.getState().refreshTasks();

    const state = useTaskCenterStore.getState();
    const { useTaskSnapshotStore } = await import('@/stores/chat/task-snapshot-store');
    expect(useTaskSnapshotStore.getState().getTaskDataList('agent:main:main').map((item) => item.id)).toEqual(['1']);
    expect(state.refreshing).toBe(false);
    expect(state.error).toBe('refresh failed');
  });

  it('refreshTasks keeps existing todo snapshot when TaskList returns an empty replay', async () => {
    listTaskSnapshotMock.mockResolvedValueOnce({ tasks: [], todos: [] });
    const { useTaskCenterStore } = await import('@/stores/task-center-store');
    const { useTaskSnapshotStore } = await import('@/stores/chat/task-snapshot-store');

    useTaskSnapshotStore.getState().reportTodos('agent:main:main', [
      { content: '已有待办', status: 'pending' },
    ]);

    await useTaskCenterStore.getState().refreshTasks({ sessionKey: 'agent:main:main' });

    expect(useTaskSnapshotStore.getState().getTaskDataList('agent:main:main')).toEqual([
      expect.objectContaining({ subject: '已有待办', status: 'pending' }),
    ]);
    expect(useTaskSnapshotStore.getState().getPersistentTaskDataList('agent:main:main')).toEqual([]);
  });

  it('refreshTasks isolates in-flight requests by session key', async () => {
    let resolveFirst: ((snapshot: TaskListSnapshot) => void) | null = null;
    listTaskSnapshotMock.mockImplementation((sessionKey) => {
      if (sessionKey === 'agent:main:first') {
        return new Promise<TaskListSnapshot>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve(snapshot([task({ id: '2', subject: 'second task' })]));
    });
    const { useTaskCenterStore } = await import('@/stores/task-center-store');
    const { useTaskSnapshotStore } = await import('@/stores/chat/task-snapshot-store');

    const firstRefresh = useTaskCenterStore.getState().refreshTasks({ sessionKey: 'agent:main:first', silent: true });
    const secondRefresh = useTaskCenterStore.getState().refreshTasks({ sessionKey: 'agent:main:second', silent: true });
    await secondRefresh;

    expect(listTaskSnapshotMock).toHaveBeenCalledWith('agent:main:first');
    expect(listTaskSnapshotMock).toHaveBeenCalledWith('agent:main:second');
    expect(useTaskSnapshotStore.getState().getTaskDataList('agent:main:second').map((item) => item.subject)).toEqual(['second task']);

    resolveFirst?.(snapshot([task({ id: '1', subject: 'first task' })]));
    await firstRefresh;

    expect(useTaskSnapshotStore.getState().getTaskDataList('agent:main:first').map((item) => item.subject)).toEqual(['first task']);
    expect(useTaskSnapshotStore.getState().getTaskDataList('agent:main:second').map((item) => item.subject)).toEqual(['second task']);
  });

  it('deleteTaskById maps to TaskUpdate status=deleted and removes task', async () => {
    listTaskSnapshotMock.mockResolvedValue(snapshot([task({ id: '3', status: 'in_progress' })]));
    updateTaskMock.mockResolvedValue({
      taskId: '3',
      deleted: true,
      todos: [],
    });
    const { useTaskCenterStore } = await import('@/stores/task-center-store');
    await useTaskCenterStore.getState().init('agent:main:main');

    await useTaskCenterStore.getState().deleteTaskById({ taskId: '3' });

    expect(updateTaskMock).toHaveBeenCalledWith({
      sessionKey: 'agent:main:main',
      taskId: '3',
      status: 'deleted',
    });
    const { useTaskSnapshotStore } = await import('@/stores/chat/task-snapshot-store');
    expect(useTaskSnapshotStore.getState().getTaskDataList('agent:main:main')).toEqual([]);
  });

  it('handleGatewayNotification patches task or removes deleted task', async () => {
    const { useTaskCenterStore } = await import('@/stores/task-center-store');
    const { useTaskSnapshotStore } = await import('@/stores/chat/task-snapshot-store');
    useTaskSnapshotStore.getState().reportTaskData('agent:main:main', [
      task({ id: '1', status: 'pending' }),
    ]);
    useTaskCenterStore.setState({
      sessionKey: 'agent:main:main',
    } as never);

    useTaskCenterStore.getState().handleGatewayNotification({
      method: 'TaskCreate',
      params: {
        sessionKey: 'agent:main:main',
        task: task({ id: '2', status: 'in_progress' }),
      },
    });
    expect(useTaskSnapshotStore.getState().getTaskDataList('agent:main:main').map((item) => item.id)).toEqual(['1', '2']);

    useTaskCenterStore.getState().handleGatewayNotification({
      method: 'TaskUpdate',
      params: { sessionKey: 'agent:main:main', taskId: '1', deleted: true },
    });
    expect(useTaskSnapshotStore.getState().getTaskDataList('agent:main:main').map((item) => item.id)).toEqual(['2']);
  });
});
