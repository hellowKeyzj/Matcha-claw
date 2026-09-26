import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('task snapshot store', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('derives plan status from one session task snapshot', async () => {
    const { useTaskSnapshotStore } = await import('@/stores/chat/task-snapshot-store');
    const store = useTaskSnapshotStore.getState();

    store.reportTaskCenterData('agent:main:main', [
      { id: '1', subject: '实现模型', description: '', status: 'in_progress', blocks: [], blockedBy: [] },
    ]);

    expect(store.getDerivedPlanStatus('agent:main:main')).toBe('ready');
    store.notifyChatStarted('agent:main:main');
    expect(useTaskSnapshotStore.getState().getDerivedPlanStatus('agent:main:main')).toBe('building');
  });

  it('keeps todo plan items out of the persistent task view', async () => {
    const { useTaskSnapshotStore } = await import('@/stores/chat/task-snapshot-store');
    const store = useTaskSnapshotStore.getState();

    store.reportTodos('agent:main:main', [
      { content: '分析页面结构', status: 'pending' },
    ]);

    expect(store.getTaskDataList('agent:main:main')).toEqual([
      expect.objectContaining({ id: 'todo-1', subject: '分析页面结构' }),
    ]);
    expect(store.getPersistentTaskDataList('agent:main:main')).toEqual([]);

    store.reportTaskCenterData('agent:main:main', [
      { id: '1', subject: '修复任务中心删除', description: '', status: 'in_progress', blocks: [], blockedBy: [] },
    ]);

    expect(useTaskSnapshotStore.getState().getPersistentTaskDataList('agent:main:main')).toEqual([
      expect.objectContaining({ id: '1', subject: '修复任务中心删除' }),
    ]);
  });

  it('empty replay clears stale todo snapshot data', async () => {
    const { useTaskSnapshotStore } = await import('@/stores/chat/task-snapshot-store');
    const store = useTaskSnapshotStore.getState();

    store.reportTaskCenterSnapshot({
      sessionKey: 'agent:main:main',
      source: 'todo',
      tasks: [],
      todos: [{ content: '保留当前 todo', status: 'in_progress' }],
    });

    store.reportTaskCenterSnapshot({
      sessionKey: 'agent:main:main',
      source: 'replay',
      tasks: [],
      todos: [],
    });

    expect(useTaskSnapshotStore.getState().getTaskDataList('agent:main:main')).toEqual([]);
  });

  it('empty task center snapshot clears stale persistent tasks from the task inbox', async () => {
    const { useTaskSnapshotStore } = await import('@/stores/chat/task-snapshot-store');
    const store = useTaskSnapshotStore.getState();

    store.reportTaskCenterData('agent:main:main', [
      { id: '1', subject: '已不存在的任务', description: '', status: 'in_progress', blocks: [], blockedBy: [] },
    ]);

    store.reportTaskCenterSnapshot({
      sessionKey: 'agent:main:main',
      source: 'replay',
      tasks: [],
      todos: [],
    });

    expect(useTaskSnapshotStore.getState().getPersistentTaskDataList('agent:main:main')).toEqual([]);
    expect(useTaskSnapshotStore.getState().getTaskDataList('agent:main:main')).toEqual([]);
    expect(useTaskSnapshotStore.getState().getDerivedPlanStatus('agent:main:main')).toBeNull();
  });

  it('task:snapshot 收到的全量列表完全替换当前 session 任务集合', async () => {
    const { useTaskSnapshotStore } = await import('@/stores/chat/task-snapshot-store');
    const store = useTaskSnapshotStore.getState();

    store.reportTaskCenterData('agent:main:main', [
      { id: '1', subject: '保留', description: '', status: 'pending', blocks: [], blockedBy: [] },
      { id: '2', subject: '将被删', description: '', status: 'in_progress', blocks: [], blockedBy: [] },
      { id: '3', subject: '将被删 2', description: '', status: 'completed', blocks: [], blockedBy: [] },
    ]);

    store.reportTaskCenterSnapshot({
      sessionKey: 'agent:main:main',
      source: 'tool',
      tasks: [
        { id: '1', subject: '保留', description: '', status: 'pending', blocks: [], blockedBy: [] },
      ],
    });

    expect(useTaskSnapshotStore.getState().getPersistentTaskDataList('agent:main:main').map((t) => t.id)).toEqual(['1']);
  });

  it('does not map an empty session task scope to the default main session', async () => {
    const { useTaskSnapshotStore } = await import('@/stores/chat/task-snapshot-store');
    const store = useTaskSnapshotStore.getState();

    expect(store.getSessionTaskScopeKey('')).toBe('');
    expect(store.getSessionTaskScopeKey('   ')).toBe('');
  });

  it('returns stable derived task references for React selectors', async () => {
    const { useTaskSnapshotStore } = await import('@/stores/chat/task-snapshot-store');
    const store = useTaskSnapshotStore.getState();

    store.reportTodos('agent:main:main', []);
    expect(store.getTaskDataList('agent:main:main')).toBe(store.getTaskDataList('agent:main:main'));
    expect(store.getStatusMap('agent:main:main')).toBe(store.getStatusMap('agent:main:main'));

    store.reportTodos('agent:main:main', [
      { content: '同步任务状态', status: 'pending' },
    ]);
    const firstTasks = store.getTaskDataList('agent:main:main');
    const firstStatusMap = store.getStatusMap('agent:main:main');

    store.reportTodos('agent:main:main', [
      { content: '同步任务状态', status: 'pending' },
    ]);

    expect(store.getTaskDataList('agent:main:main')).toBe(firstTasks);
    expect(store.getStatusMap('agent:main:main')).toBe(firstStatusMap);
  });
});
