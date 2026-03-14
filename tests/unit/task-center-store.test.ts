import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@/services/openclaw/task-manager-client';

const getWorkspaceDirMock = vi.fn<() => Promise<string | null>>();
const getTaskWorkspaceDirsMock = vi.fn<() => Promise<string[]>>();
const getTaskPluginStatusMock = vi.fn();
const installTaskPluginMock = vi.fn();
const listTasksMock = vi.fn<(workspaceDir?: string) => Promise<Task[]>>();
const resumeTaskMock = vi.fn();
const wakeTaskSessionMock = vi.fn();

vi.mock('@/services/openclaw/task-manager-client', () => ({
  getWorkspaceDir: (...args: unknown[]) => getWorkspaceDirMock(...args),
  getTaskWorkspaceDirs: (...args: unknown[]) => getTaskWorkspaceDirsMock(...args),
  getTaskPluginStatus: (...args: unknown[]) => getTaskPluginStatusMock(...args),
  installTaskPlugin: (...args: unknown[]) => installTaskPluginMock(...args),
  listTasks: (...args: unknown[]) => listTasksMock(...args),
  resumeTask: (...args: unknown[]) => resumeTaskMock(...args),
  wakeTaskSession: (...args: unknown[]) => wakeTaskSessionMock(...args),
}));

function task(overrides: Partial<Task>): Task {
  return {
    id: 'task-1',
    goal: 'goal',
    status: 'running',
    progress: 0.5,
    plan_markdown: '- [ ] step',
    created_at: 1,
    updated_at: 2,
    ...overrides,
  };
}

describe('task center store', () => {
  beforeEach(() => {
    vi.resetModules();
    getWorkspaceDirMock.mockReset();
    getTaskWorkspaceDirsMock.mockReset();
    getTaskPluginStatusMock.mockReset();
    installTaskPluginMock.mockReset();
    listTasksMock.mockReset();
    resumeTaskMock.mockReset();
    wakeTaskSessionMock.mockReset();
  });

  it('init 在插件可用时加载任务并生成 blockedQueue', async () => {
    getWorkspaceDirMock.mockResolvedValue('E:/workspace/main');
    getTaskWorkspaceDirsMock.mockResolvedValue(['E:/workspace/main']);
    getTaskPluginStatusMock.mockResolvedValue({
      installed: true,
      enabled: true,
      skillEnabled: true,
      version: '1.0.0',
      pluginDir: 'x',
    });
    listTasksMock.mockResolvedValue([
      task({ id: 'waiting-1', status: 'waiting_for_input', blocked_info: { reason: 'need_user_confirm', confirm_id: 'c1', question: '请输入审批意见' } }),
      task({ id: 'running-1', status: 'running' }),
    ]);
    const { useTaskCenterStore } = await import('@/stores/task-center-store');

    await useTaskCenterStore.getState().init();

    const state = useTaskCenterStore.getState();
    expect(state.pluginInstalled).toBe(true);
    expect(state.pluginEnabled).toBe(true);
    expect(state.tasks).toHaveLength(2);
    expect(state.blockedQueue).toHaveLength(1);
    expect(state.blockedQueue[0]).toMatchObject({ taskId: 'waiting-1', confirmId: 'c1' });
  });

  it('resumeBlockedTask 提交后会更新任务并移除阻塞队列', async () => {
    getWorkspaceDirMock.mockResolvedValue('E:/workspace/main');
    getTaskWorkspaceDirsMock.mockResolvedValue(['E:/workspace/main']);
    getTaskPluginStatusMock.mockResolvedValue({
      installed: true,
      enabled: true,
      skillEnabled: true,
      version: '1.0.0',
      pluginDir: 'x',
    });
    listTasksMock.mockResolvedValue([
      task({ id: 'waiting-2', status: 'waiting_for_input', blocked_info: { reason: 'need_user_confirm', confirm_id: 'c2', question: '是否继续' } }),
    ]);
    resumeTaskMock.mockResolvedValue(task({ id: 'waiting-2', status: 'running', blocked_info: undefined }));
    const { useTaskCenterStore } = await import('@/stores/task-center-store');
    await useTaskCenterStore.getState().init();

    await useTaskCenterStore.getState().resumeBlockedTask({
      taskId: 'waiting-2',
      confirmId: 'c2',
      decision: 'approve',
    });

    const state = useTaskCenterStore.getState();
    expect(resumeTaskMock).toHaveBeenCalled();
    expect(state.blockedQueue).toHaveLength(0);
    expect(state.tasks[0]?.status).toBe('running');
  });

  it('handleGatewayNotification 兼容 task_created 并写入任务列表', async () => {
    const { useTaskCenterStore } = await import('@/stores/task-center-store');

    useTaskCenterStore.getState().handleGatewayNotification({
      method: 'task_created',
      params: {
        task: task({ id: 'task-created-2', status: 'pending' }),
      },
    });

    const state = useTaskCenterStore.getState();
    expect(state.tasks.some((item) => item.id === 'task-created-2')).toBe(true);
  });
});
