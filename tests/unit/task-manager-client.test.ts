import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeIpcMock = vi.fn();

vi.mock('@/lib/api-client', () => ({
  invokeIpc: (...args: unknown[]) => invokeIpcMock(...args),
}));

describe('task manager client', () => {
  beforeEach(() => {
    invokeIpcMock.mockReset();
  });

  it('listTasks 通过 gateway:rpc 拉取任务列表', async () => {
    invokeIpcMock.mockResolvedValueOnce({
      success: true,
      result: { tasks: [{ id: 'task-1' }] },
    });
    const { listTasks } = await import('@/lib/openclaw/task-manager-client');
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
    const { resumeTask } = await import('@/lib/openclaw/task-manager-client');
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

  it('getTaskPluginStatus/installTaskPlugin 走 task:* IPC', async () => {
    invokeIpcMock.mockResolvedValueOnce({ installed: true, enabled: true, skillEnabled: true, pluginDir: 'x' });
    invokeIpcMock.mockResolvedValueOnce({ success: true, installed: true });
    const { getTaskPluginStatus, installTaskPlugin } = await import('@/lib/openclaw/task-manager-client');

    const status = await getTaskPluginStatus();
    const install = await installTaskPlugin();

    expect(status.installed).toBe(true);
    expect(install.success).toBe(true);
    expect(invokeIpcMock).toHaveBeenNthCalledWith(1, 'task:pluginStatus');
    expect(invokeIpcMock).toHaveBeenNthCalledWith(2, 'task:pluginInstall');
  });
});
