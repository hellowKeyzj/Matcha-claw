import { beforeEach, describe, expect, it, vi } from 'vitest';

const hostApiFetchMock = vi.fn();

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
  hostOpenClawGetTaskWorkspaceDirs: vi.fn(async () => []),
  hostOpenClawGetWorkspaceDir: vi.fn(async () => null),
}));

describe('task manager client', () => {
  beforeEach(() => {
    hostApiFetchMock.mockReset();
  });

  it('listTasks 通过 runtime-host task 路由拉取任务摘要', async () => {
    hostApiFetchMock.mockResolvedValueOnce({
      tasks: [
        { id: 'task-1', subject: '整理需求', status: 'in_progress', blockedBy: [] },
      ],
      ready: true,
      refreshing: false,
    });
    const { listTaskSnapshot } = await import('@/services/openclaw/task-manager-client');
    const snapshot = await listTaskSnapshot('E:/workspace/main');

    expect(snapshot.ready).toBe(true);
    expect(snapshot.refreshing).toBe(false);
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0]).toMatchObject({
      id: 'task-1',
      subject: '整理需求',
      status: 'in_progress',
    });
    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/tasks/list', {
      method: 'POST',
      body: JSON.stringify({ workspaceDir: 'E:/workspace/main' }),
      timeoutMs: 60000,
    });
  });

  it('listTaskSnapshot 保留 runtime-host not-ready 状态', async () => {
    hostApiFetchMock.mockResolvedValueOnce({
      success: true,
      tasks: [],
      ready: false,
      refreshing: true,
      updatedAt: null,
      error: null,
    });
    const { listTaskSnapshot } = await import('@/services/openclaw/task-manager-client');
    const snapshot = await listTaskSnapshot();

    expect(snapshot).toMatchObject({
      tasks: [],
      ready: false,
      refreshing: true,
      updatedAt: null,
      error: null,
    });
  });

  it('createTask 通过 runtime-host task 路由创建任务', async () => {
    hostApiFetchMock.mockResolvedValueOnce({
      task: {
        id: 'task-2',
        subject: '实现接口',
        description: '完成 task manager claim 接口',
        status: 'pending',
        blockedBy: [],
        blocks: [],
        createdAt: 1,
        updatedAt: 2,
      },
    });
    const { createTask } = await import('@/services/openclaw/task-manager-client');
    const task = await createTask({
      subject: '实现接口',
      description: '完成 task manager claim 接口',
      workspaceDir: 'E:/workspace/main',
    });

    expect(task.id).toBe('task-2');
    expect(task.status).toBe('pending');
    expect(task.subject).toBe('实现接口');
    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/tasks/create', {
      method: 'POST',
      body: JSON.stringify({
      subject: '实现接口',
      description: '完成 task manager claim 接口',
      workspaceDir: 'E:/workspace/main',
      }),
      timeoutMs: 60000,
    });
  });

  it('updateTask 透传可更新字段并返回更新结果', async () => {
    hostApiFetchMock.mockResolvedValueOnce({
      task: {
        id: 'task-3',
        subject: '完成开发',
        description: '全部完成',
        status: 'completed',
        blockedBy: [],
        blocks: [],
        createdAt: 1,
        updatedAt: 3,
      },
      updatedFields: ['status'],
      statusChange: { from: 'in_progress', to: 'completed' },
    });
    const { updateTask } = await import('@/services/openclaw/task-manager-client');
    const result = await updateTask({
      taskId: 'task-3',
      status: 'completed',
      workspaceDir: 'E:/workspace/main',
    });

    expect(result.task.status).toBe('completed');
    expect(result.updatedFields).toEqual(['status']);
    expect(result.statusChange).toEqual({ from: 'in_progress', to: 'completed' });
    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/tasks/update', {
      method: 'POST',
      body: JSON.stringify({
      taskId: 'task-3',
      status: 'completed',
      workspaceDir: 'E:/workspace/main',
      }),
      timeoutMs: 60000,
    });
  });

  it('claimTask 通过 runtime-host task 路由领取任务', async () => {
    hostApiFetchMock.mockResolvedValueOnce({
      task: {
        id: 'task-4',
        subject: '修复回归',
        description: '处理 store 竞态',
        status: 'in_progress',
        owner: 'agent-alpha',
        blockedBy: [],
        blocks: [],
        createdAt: 1,
        updatedAt: 4,
      },
    });
    const { claimTask } = await import('@/services/openclaw/task-manager-client');
    const task = await claimTask({
      taskId: 'task-4',
      owner: 'agent-alpha',
      workspaceDir: 'E:/workspace/main',
      sessionKey: 'agent:alpha:main',
    });

    expect(task.status).toBe('in_progress');
    expect(task.owner).toBe('agent-alpha');
    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/tasks/claim', {
      method: 'POST',
      body: JSON.stringify({
      taskId: 'task-4',
      owner: 'agent-alpha',
      workspaceDir: 'E:/workspace/main',
      sessionKey: 'agent:alpha:main',
      }),
      timeoutMs: 60000,
    });
  });
});
