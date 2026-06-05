import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task, TaskListSnapshot } from '@/services/openclaw/task-manager-client';
import { createOpenClawTestRuntimeAddress } from './helpers/runtime-address-fixtures';

const runtimeAddress = createOpenClawTestRuntimeAddress('agent:main:main');
const firstRuntimeAddress = createOpenClawTestRuntimeAddress('agent:main:first');
const secondRuntimeAddress = createOpenClawTestRuntimeAddress('agent:main:second');

const listTaskSnapshotMock = vi.fn<(payload: { sessionKey: string; runtimeAddress: typeof runtimeAddress; teamKey?: string }) => Promise<TaskListSnapshot>>();
const updateTaskMock = vi.fn();

vi.mock('@/services/openclaw/task-manager-client', () => ({
  listTaskSnapshot: (...args: [{ sessionKey: string; runtimeAddress: typeof runtimeAddress; teamKey?: string }]) => listTaskSnapshotMock(...args),
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

function snapshot(tasks: Task[], sessionKey = 'agent:main:main'): TaskListSnapshot {
  return {
    scope: {
      type: 'session',
      key: sessionKey,
      label: sessionKey,
      sessionKey,
    },
    tasks,
    todos: [],
  };
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

    await useTaskCenterStore.getState().init({ sessionKey: 'agent:main:main', runtimeAddress });

    const state = useTaskCenterStore.getState();
    const { useTaskSnapshotStore } = await import('@/stores/chat/task-snapshot-store');
    expect(state.sessionKey).toBe('agent:main:main');
    expect(state.initialLoading).toBe(false);
    expect(state.refreshing).toBe(false);
    expect(state.initialized).toBe(true);
    expect(useTaskSnapshotStore.getState().getTaskDataList('agent:main:main').map((item) => item.id)).toEqual(['1', '2']);
    expect(listTaskSnapshotMock).toHaveBeenCalledWith({ sessionKey: 'agent:main:main', runtimeAddress });
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
    await useTaskCenterStore.getState().init({ sessionKey: 'agent:main:main', runtimeAddress });

    listTaskSnapshotMock.mockRejectedValueOnce(new Error('refresh failed'));
    await useTaskCenterStore.getState().refreshTasks();

    const state = useTaskCenterStore.getState();
    const { useTaskSnapshotStore } = await import('@/stores/chat/task-snapshot-store');
    expect(useTaskSnapshotStore.getState().getTaskDataList('agent:main:main').map((item) => item.id)).toEqual(['1']);
    expect(state.refreshing).toBe(false);
    expect(state.error).toBe('refresh failed');
  });

  it('refreshTasks clears existing todo snapshot when TaskList returns an empty snapshot', async () => {
    listTaskSnapshotMock.mockResolvedValueOnce({ tasks: [], todos: [] });
    const { useTaskCenterStore } = await import('@/stores/task-center-store');
    const { useTaskSnapshotStore } = await import('@/stores/chat/task-snapshot-store');

    useTaskSnapshotStore.getState().reportTodos('agent:main:main', [
      { content: '已有待办', status: 'pending' },
    ]);

    await useTaskCenterStore.getState().refreshTasks({ sessionKey: 'agent:main:main', runtimeAddress });

    expect(useTaskSnapshotStore.getState().getTaskDataList('agent:main:main')).toEqual([]);
    expect(useTaskSnapshotStore.getState().getPersistentTaskDataList('agent:main:main')).toEqual([]);
  });

  it('refreshTasks isolates in-flight requests by session key', async () => {
    let resolveFirst: ((snapshot: TaskListSnapshot) => void) | null = null;
    listTaskSnapshotMock.mockImplementation((payload) => {
      const sessionKey = payload.sessionKey;
      if (sessionKey === 'agent:main:first') {
        return new Promise<TaskListSnapshot>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve(snapshot([task({ id: '2', subject: 'second task' })], sessionKey));
    });
    const { useTaskCenterStore } = await import('@/stores/task-center-store');
    const { useTaskSnapshotStore } = await import('@/stores/chat/task-snapshot-store');

    const firstRefresh = useTaskCenterStore.getState().refreshTasks({ sessionKey: 'agent:main:first', runtimeAddress: firstRuntimeAddress, silent: true });
    const secondRefresh = useTaskCenterStore.getState().refreshTasks({ sessionKey: 'agent:main:second', runtimeAddress: secondRuntimeAddress, silent: true });
    await secondRefresh;

    expect(listTaskSnapshotMock).toHaveBeenCalledWith({ sessionKey: 'agent:main:first', runtimeAddress: firstRuntimeAddress });
    expect(listTaskSnapshotMock).toHaveBeenCalledWith({ sessionKey: 'agent:main:second', runtimeAddress: secondRuntimeAddress });
    expect(useTaskSnapshotStore.getState().getTaskDataList('agent:main:second').map((item) => item.subject)).toEqual(['second task']);

    resolveFirst?.(snapshot([task({ id: '1', subject: 'first task' })], 'agent:main:first'));
    await firstRefresh;

    expect(useTaskSnapshotStore.getState().getTaskDataList('agent:main:first').map((item) => item.subject)).toEqual(['first task']);
    expect(useTaskSnapshotStore.getState().getTaskDataList('agent:main:second').map((item) => item.subject)).toEqual(['second task']);
  });

  it('deleteTaskById 调用 TaskUpdate(status=deleted) 后用 TaskList 全量刷新', async () => {
    listTaskSnapshotMock.mockResolvedValueOnce(snapshot([
      task({ id: '1', status: 'pending' }),
      task({ id: '2', status: 'in_progress' }),
      task({ id: '3', status: 'completed' }),
    ]));
    updateTaskMock.mockResolvedValueOnce({ taskId: '2', deleted: true, todos: [] });
    listTaskSnapshotMock.mockResolvedValueOnce(snapshot([
      task({ id: '1', status: 'pending' }),
      task({ id: '3', status: 'completed' }),
    ]));
    const { useTaskCenterStore } = await import('@/stores/task-center-store');
    const { useTaskSnapshotStore } = await import('@/stores/chat/task-snapshot-store');
    await useTaskCenterStore.getState().init({ sessionKey: 'agent:main:main', runtimeAddress });

    await useTaskCenterStore.getState().deleteTaskById({ taskId: '2' });

    expect(updateTaskMock).toHaveBeenCalledWith({
      sessionKey: 'agent:main:main',
      runtimeAddress,
      taskId: '2',
      status: 'deleted',
    });
    expect(listTaskSnapshotMock).toHaveBeenCalledTimes(2);
    expect(useTaskSnapshotStore.getState().getTaskDataList('agent:main:main').map((item) => item.id)).toEqual(['1', '3']);
  });
});
