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

  it('listTasks 通过 gateway:rpc 拉取任务列表', async () => {
    hostGatewayRpcMock.mockResolvedValueOnce({ tasks: [{ id: 'task-1' }] });
    const { listTasks } = await import('@/services/openclaw/task-manager-client');
    const tasks = await listTasks('E:/workspace/main');

    expect(tasks).toHaveLength(1);
    expect(hostGatewayRpcMock).toHaveBeenCalledWith('task_list', { workspaceDir: 'E:/workspace/main' }, 60000);
  });

  it('resumeTask 透传 confirmId/decision/userInput', async () => {
    hostGatewayRpcMock.mockResolvedValueOnce({
      task: { id: 'task-2', goal: 'goal', status: 'running', progress: 0.6, plan_markdown: '', created_at: 1, updated_at: 2 },
    });
    const { resumeTask } = await import('@/services/openclaw/task-manager-client');
    const task = await resumeTask('task-2', {
      confirmId: 'confirm-1',
      decision: 'approve',
      userInput: 'yes',
      workspaceDir: 'E:/workspace/main',
    });

    expect(task.id).toBe('task-2');
    expect(hostGatewayRpcMock).toHaveBeenCalledWith('task_resume', {
      taskId: 'task-2',
      confirmId: 'confirm-1',
      decision: 'approve',
      userInput: 'yes',
      workspaceDir: 'E:/workspace/main',
    }, 60000);
  });

  it('wakeTaskSession 会携带任务上下文与 workspace 路径', async () => {
    hostGatewayRpcMock.mockResolvedValueOnce({});
    const { wakeTaskSession } = await import('@/services/openclaw/task-manager-client');
    await wakeTaskSession('task-3', {
      assignedSession: 'agent:main:task:abc',
      task: {
        id: 'task-3',
        goal: '导出任务日志',
        status: 'running',
        progress: 0.2,
        steps: [
          {
            id: 'step-1',
            title: '需求分析',
            status: 'running',
            depends_on: [],
            created_at: 1,
            updated_at: 2,
          },
        ],
        current_step_id: 'step-1',
        checkpoints: [],
        created_at: 1,
        updated_at: 2,
        workspaceDir: 'C:/Users/Mr.Key/.openclaw/workspace',
      },
    });

    expect(hostGatewayRpcMock).toHaveBeenCalledWith(
      'agent',
      expect.objectContaining({
        agentId: 'main',
        sessionKey: 'agent:main:task:abc',
      }),
      60000,
    );
    const payload = hostGatewayRpcMock.mock.calls[0]?.[1] as { message?: string };
    expect(payload.message).toContain('请恢复执行任务 task-3');
    expect(payload.message).toContain('任务目标：导出任务日志');
    expect(payload.message).toContain('任务文件路径：C:/Users/Mr.Key/.openclaw/workspace\\.task-manager\\tasks.json');
  });
});
