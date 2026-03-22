import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeIpcMock = vi.fn();

vi.mock('@/lib/api-client', () => ({
  invokeIpc: (...args: unknown[]) => invokeIpcMock(...args),
}));

describe('task manager client', () => {
  beforeEach(() => {
    vi.resetModules();
    invokeIpcMock.mockReset();
  });

  it('listTasks 通过 gateway:rpc 拉取任务列表', async () => {
    invokeIpcMock.mockResolvedValueOnce({
      success: true,
      result: { tasks: [{ id: 'task-1' }] },
    });
    const { listTasks } = await import('@/services/openclaw/task-manager-client');
    const tasks = await listTasks('E:/workspace/main');

    expect(tasks).toHaveLength(1);
    expect(invokeIpcMock).toHaveBeenCalledWith('gateway:rpc', 'task_list', { workspaceDir: 'E:/workspace/main' }, 60000);
  });

  it('resumeTask 透传 confirmId/decision/userInput', async () => {
    invokeIpcMock.mockResolvedValueOnce({
      success: true,
      result: {
        task: { id: 'task-2', goal: 'goal', status: 'running', progress: 0.6, plan_markdown: '', created_at: 1, updated_at: 2 },
      },
    });
    const { resumeTask } = await import('@/services/openclaw/task-manager-client');
    const task = await resumeTask('task-2', {
      confirmId: 'confirm-1',
      decision: 'approve',
      userInput: 'yes',
      workspaceDir: 'E:/workspace/main',
    });

    expect(task.id).toBe('task-2');
    expect(invokeIpcMock).toHaveBeenCalledWith('gateway:rpc', 'task_resume', {
      taskId: 'task-2',
      confirmId: 'confirm-1',
      decision: 'approve',
      userInput: 'yes',
      workspaceDir: 'E:/workspace/main',
    }, 60000);
  });

  it('wakeTaskSession 会携带任务上下文与 workspace 路径', async () => {
    invokeIpcMock.mockResolvedValueOnce({
      success: true,
      result: {},
    });
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

    expect(invokeIpcMock).toHaveBeenCalledWith(
      'gateway:rpc',
      'agent',
      expect.objectContaining({
        agentId: 'main',
        sessionKey: 'agent:main:task:abc',
      }),
      60000,
    );
    const payload = invokeIpcMock.mock.calls[0]?.[2] as { message?: string };
    expect(payload.message).toContain('请恢复执行任务 task-3');
    expect(payload.message).toContain('任务目标：导出任务日志');
    expect(payload.message).toContain('任务文件路径：C:/Users/Mr.Key/.openclaw/workspace\\.task-manager\\tasks.json');
  });

  it('getTaskPluginStatus/installTaskPlugin/uninstallTaskPlugin 走 task:* IPC', async () => {
    invokeIpcMock.mockResolvedValueOnce({ installed: true, enabled: true, skillEnabled: true, pluginDir: 'x' });
    invokeIpcMock.mockResolvedValueOnce({ success: true, installed: true });
    invokeIpcMock.mockResolvedValueOnce({ success: true, installed: false });
    const { getTaskPluginStatus, installTaskPlugin, uninstallTaskPlugin } = await import('@/services/openclaw/task-manager-client');

    const status = await getTaskPluginStatus();
    const install = await installTaskPlugin();
    const uninstall = await uninstallTaskPlugin();

    expect(status.installed).toBe(true);
    expect(install.success).toBe(true);
    expect(uninstall.success).toBe(true);
    expect(invokeIpcMock).toHaveBeenNthCalledWith(1, 'task:pluginStatus');
    expect(invokeIpcMock).toHaveBeenNthCalledWith(2, 'task:pluginInstall');
    expect(invokeIpcMock).toHaveBeenNthCalledWith(3, 'task:pluginUninstall');
  });
});
