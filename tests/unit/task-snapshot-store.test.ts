import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('task snapshot store', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('derives plan status from one session task snapshot', async () => {
    const { useTaskSnapshotStore } = await import('@/stores/chat/task-snapshot-store');
    const store = useTaskSnapshotStore.getState();

    store.reportTaskData('agent:main:main', [
      { id: '1', subject: '实现模型', description: '', status: 'in_progress', blocks: [], blockedBy: [] },
    ]);

    expect(store.getDerivedPlanStatus('agent:main:main')).toBe('ready');
    store.notifyChatStarted('agent:main:main');
    expect(useTaskSnapshotStore.getState().getDerivedPlanStatus('agent:main:main')).toBe('building');
  });

  it('normalizes TodoWrite notification into todo task data without driving task inbox plan status', async () => {
    const { useTaskSnapshotStore } = await import('@/stores/chat/task-snapshot-store');

    useTaskSnapshotStore.getState().reportGatewayNotification({
      method: 'TodoWrite',
      params: {
        sessionKey: 'agent:main:main',
        todos: [{ content: '同步方案', status: 'completed' }],
      },
    });

    expect(useTaskSnapshotStore.getState().getTaskDataList('agent:main:main')).toEqual([
      expect.objectContaining({ id: 'todo-1', subject: '同步方案', status: 'completed' }),
    ]);
    expect(useTaskSnapshotStore.getState().getPersistentTaskDataList('agent:main:main')).toEqual([]);
    expect(useTaskSnapshotStore.getState().getDerivedPlanStatus('agent:main:main')).toBeNull();
  });

  it('normalizes TodoGet notification as todo state without persistent tasks', async () => {
    const { useTaskSnapshotStore } = await import('@/stores/chat/task-snapshot-store');

    useTaskSnapshotStore.getState().reportGatewayNotification({
      method: 'TodoGet',
      params: {
        sessionKey: 'agent:main:main',
        todos: [{ content: '读取当前待办', status: 'in_progress' }],
      },
    });

    expect(useTaskSnapshotStore.getState().getTaskDataList('agent:main:main')).toEqual([
      expect.objectContaining({ id: 'todo-1', subject: '读取当前待办', status: 'in_progress' }),
    ]);
    expect(useTaskSnapshotStore.getState().getPersistentTaskDataList('agent:main:main')).toEqual([]);
  });

  it('keeps todo plan items out of the persistent task view', async () => {
    const { useTaskSnapshotStore } = await import('@/stores/chat/task-snapshot-store');
    const store = useTaskSnapshotStore.getState();

    store.reportGatewayNotification({
      method: 'TodoWrite',
      params: {
        sessionKey: 'agent:main:main',
        todos: [{ content: '分析页面结构', status: 'pending' }],
      },
    });

    expect(store.getTaskDataList('agent:main:main')).toEqual([
      expect.objectContaining({ id: 'todo-1', subject: '分析页面结构' }),
    ]);
    expect(store.getPersistentTaskDataList('agent:main:main')).toEqual([]);

    store.reportTaskData('agent:main:main', [
      { id: '1', subject: '修复任务中心删除', description: '', status: 'in_progress', blocks: [], blockedBy: [] },
    ]);

    expect(useTaskSnapshotStore.getState().getPersistentTaskDataList('agent:main:main')).toEqual([
      expect.objectContaining({ id: '1', subject: '修复任务中心删除' }),
    ]);
  });

  it('does not let an empty replay erase existing todo snapshot data', async () => {
    const { useTaskSnapshotStore } = await import('@/stores/chat/task-snapshot-store');
    const store = useTaskSnapshotStore.getState();

    store.reportSnapshotEvent({
      sessionKey: 'agent:main:main',
      source: 'todo',
      tasks: [],
      todos: [{ content: '保留当前 todo', status: 'in_progress' }],
    });

    store.reportSnapshotEvent({
      sessionKey: 'agent:main:main',
      source: 'replay',
      tasks: [],
      todos: [],
    });

    expect(useTaskSnapshotStore.getState().getTaskDataList('agent:main:main')).toEqual([
      expect.objectContaining({ subject: '保留当前 todo', status: 'in_progress' }),
    ]);
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

  it('replays tasks artifact from session snapshot', async () => {
    const { useTaskSnapshotStore } = await import('@/stores/chat/task-snapshot-store');

    useTaskSnapshotStore.getState().reportSessionSnapshot({
      sessionKey: 'agent:main:main',
      catalog: { key: 'agent:main:main', agentId: 'main', kind: 'main', preferred: true },
      items: [],
      replayComplete: true,
      runtime: {
        sending: false,
        activeRunId: null,
        runPhase: 'idle',
        activeTurnItemKey: null,
        pendingTurnKey: null,
        pendingTurnLaneKey: null,
        pendingFinal: false,
        lastUserMessageAt: null,
        lastError: null,
        lastIssue: null,
        updatedAt: null,
      },
      window: {
        totalItemCount: 0,
        windowStartOffset: 0,
        windowEndOffset: 0,
        hasMore: false,
        hasNewer: false,
        isAtLatest: true,
      },
      taskSnapshot: {
        sessionKey: 'agent:main:main',
        source: 'artifact',
        tasks: [{ id: '1', subject: '回放任务', description: '', status: 'pending', blocks: [], blockedBy: [] }],
        uri: 'agent:///agent:main:main/tasks/agent:main:main',
        enableEdit: false,
      },
    });

    expect(useTaskSnapshotStore.getState().getTaskDataList('agent:main:main')[0]?.subject).toBe('回放任务');
  });
});
