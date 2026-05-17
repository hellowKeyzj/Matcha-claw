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

  it('does not let session snapshot task artifacts drive the task inbox', async () => {
    const { useTaskSnapshotStore } = await import('@/stores/chat/task-snapshot-store');

    useTaskSnapshotStore.getState().reportSessionSnapshot({
      sessionKey: 'agent:main:main',
      catalog: { key: 'agent:main:main', agentId: 'main', kind: 'main', preferred: true },
      items: [],
      replayComplete: true,
      runtime: {
        activeRunId: null,
        runPhase: 'idle',
        activeTurnItemKey: null,
        pendingTurnKey: null,
        pendingTurnLaneKey: null,
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

    expect(useTaskSnapshotStore.getState().getPersistentTaskDataList('agent:main:main')).toEqual([]);
  });

  it('does not expose transient historical task events while replaying a session snapshot', async () => {
    const { useTaskSnapshotStore } = await import('@/stores/chat/task-snapshot-store');
    const seenCounts: number[] = [];
    const unsubscribe = useTaskSnapshotStore.subscribe((state) => {
      seenCounts.push(state.getPersistentTaskDataList('agent:main:main').length);
    });

    useTaskSnapshotStore.getState().reportSessionSnapshot({
      sessionKey: 'agent:main:main',
      catalog: { key: 'agent:main:main', agentId: 'main', kind: 'main', preferred: true },
      items: [{
        key: 'assistant-turn:1',
        kind: 'assistant-turn',
        sessionKey: 'agent:main:main',
        role: 'assistant',
        identitySource: 'run',
        identityMode: 'run',
        identityConfidence: 'strong',
        status: 'final',
        segments: [],
        thinking: null,
        text: '',
        images: [],
        attachedFiles: [],
        tools: [{
          id: 'call_1',
          toolCallId: 'call_1',
          name: 'TaskCreate',
          displayTitle: 'TaskCreate',
          input: {},
          status: 'completed',
          output: {
            task: { id: '1', subject: '历史旧任务', description: '', status: 'pending', blocks: [], blockedBy: [] },
          },
          result: {
            kind: 'json',
            surface: 'tool-card',
            collapsedPreview: '',
            bodyText: '{"task":{"id":"1","subject":"历史旧任务","description":"","status":"pending","blocks":[],"blockedBy":[]}}',
          },
        }],
      }],
      replayComplete: true,
      runtime: {
        activeRunId: null,
        runPhase: 'done',
        activeTurnItemKey: null,
        pendingTurnKey: null,
        pendingTurnLaneKey: null,
        lastUserMessageAt: null,
        lastError: null,
        lastIssue: null,
        updatedAt: null,
      },
      window: {
        totalItemCount: 1,
        windowStartOffset: 0,
        windowEndOffset: 1,
        hasMore: false,
        hasNewer: false,
        isAtLatest: true,
      },
    });
    unsubscribe();

    expect(seenCounts).not.toContain(1);
    expect(useTaskSnapshotStore.getState().getPersistentTaskDataList('agent:main:main')).toEqual([]);
  });
});
