import { beforeEach, describe, expect, it, vi } from 'vitest';

const hostGatewayRpcMock = vi.fn();

vi.mock('@/lib/host-api', () => ({
  hostGatewayRpc: (...args: unknown[]) => hostGatewayRpcMock(...args),
  hostOpenClawGetTaskWorkspaceDirs: vi.fn(async () => []),
  hostOpenClawGetWorkspaceDir: vi.fn(async () => null),
}));

describe('task manager client', () => {
  beforeEach(() => {
    hostGatewayRpcMock.mockReset();
  });

  it('listTasks 通过 task_manager.list 拉取任务摘要', async () => {
    hostGatewayRpcMock.mockResolvedValueOnce({
      tasks: [
        { id: 'task-1', subject: '整理需求', status: 'in_progress', blockedBy: [] },
      ],
    });
    const { listTasks } = await import('@/services/openclaw/task-manager-client');
    const tasks = await listTasks('E:/workspace/main');

    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      id: 'task-1',
      subject: '整理需求',
      status: 'in_progress',
    });
    expect(hostGatewayRpcMock).toHaveBeenCalledWith('task_manager.list', { workspaceDir: 'E:/workspace/main' }, 60000);
  });

  it('createTask 通过 task_manager.create 创建任务', async () => {
    hostGatewayRpcMock.mockResolvedValueOnce({
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
    expect(hostGatewayRpcMock).toHaveBeenCalledWith('task_manager.create', {
      subject: '实现接口',
      description: '完成 task manager claim 接口',
      workspaceDir: 'E:/workspace/main',
    }, 60000);
  });

  it('updateTask 透传可更新字段并返回更新结果', async () => {
    hostGatewayRpcMock.mockResolvedValueOnce({
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
    expect(hostGatewayRpcMock).toHaveBeenCalledWith('task_manager.update', {
      taskId: 'task-3',
      status: 'completed',
      workspaceDir: 'E:/workspace/main',
    }, 60000);
  });

  it('claimTask 通过 task_manager.claim 领取任务', async () => {
    hostGatewayRpcMock.mockResolvedValueOnce({
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
    expect(hostGatewayRpcMock).toHaveBeenCalledWith('task_manager.claim', {
      taskId: 'task-4',
      owner: 'agent-alpha',
      workspaceDir: 'E:/workspace/main',
      sessionKey: 'agent:alpha:main',
    }, 60000);
  });
});
