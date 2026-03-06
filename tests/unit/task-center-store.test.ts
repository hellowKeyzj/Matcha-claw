import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTaskCenterStore } from '@/stores/task-center-store';

function resetTaskCenterState() {
  useTaskCenterStore.setState({
    tasks: [],
    loading: false,
    initialized: false,
    error: null,
    workspaceDir: null,
    pluginInstalled: false,
    pluginEnabled: false,
    pluginVersion: undefined,
    blockedQueue: [],
  });
}

describe('task center store', () => {
  beforeEach(() => {
    vi.mocked(window.electron.ipcRenderer.invoke).mockReset();
    resetTaskCenterState();
  });

  it('initializes with workspace + plugin status and loads tasks', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke.mockImplementation(async (channel: unknown, ...args: unknown[]) => {
      if (channel === 'openclaw:getWorkspaceDir') {
        return 'E:/workspace/demo';
      }
      if (channel === 'task:pluginStatus') {
        return {
          installed: true,
          enabled: true,
          skillEnabled: true,
          version: '1.0.0',
          pluginDir: 'E:/user/.openclaw/extensions/task-manager',
        };
      }
      if (channel === 'gateway:rpc') {
        const method = String(args[0] ?? '');
        if (method === 'task_list') {
          return {
            success: true,
            result: {
              tasks: [
                {
                  id: 'task-1',
                  goal: 'demo',
                  status: 'running',
                  progress: 0.5,
                  plan_markdown: '- [x] a\n- [ ] b',
                  created_at: 1,
                  updated_at: 2,
                },
              ],
            },
          };
        }
      }
      return { success: true, result: {} };
    });

    await useTaskCenterStore.getState().init();
    const state = useTaskCenterStore.getState();
    expect(state.initialized).toBe(true);
    expect(state.workspaceDir).toBe('E:/workspace/demo');
    expect(state.pluginInstalled).toBe(true);
    expect(state.pluginEnabled).toBe(true);
    expect(state.tasks).toHaveLength(1);
    expect(state.tasks[0].id).toBe('task-1');
  });

  it('pushes blocked task into queue when receiving task_blocked notification', () => {
    useTaskCenterStore.getState().handleGatewayNotification({
      method: 'task_blocked',
      params: {
        taskId: 'task-2',
        confirmId: 'confirm-2',
        question: '是否覆盖文件？',
        task: {
          id: 'task-2',
          goal: '覆盖测试',
          status: 'waiting_for_input',
          progress: 0.3,
          plan_markdown: '',
          created_at: 1,
          updated_at: 2,
          blocked_info: { reason: 'need_user_confirm', confirm_id: 'confirm-2', question: '是否覆盖文件？' },
        },
      },
    });

    const state = useTaskCenterStore.getState();
    expect(state.blockedQueue).toHaveLength(1);
    expect(state.blockedQueue[0]).toMatchObject({
      taskId: 'task-2',
      confirmId: 'confirm-2',
      prompt: '是否覆盖文件？',
      type: 'waiting_for_input',
    });
  });

  it('wakes main session after task_needs_resume notification', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke.mockImplementation(async (channel: unknown, ...args: unknown[]) => {
      if (channel === 'gateway:rpc') {
        const method = String(args[0] ?? '');
        if (method === 'agent') {
          return { success: true, result: { ok: true } };
        }
      }
      return { success: true, result: {} };
    });

    useTaskCenterStore.getState().handleGatewayNotification({
      method: 'task_needs_resume',
      params: {
        taskId: 'task-3',
        userInput: 'yes',
      },
    });

    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const gatewayRpcCalls = invoke.mock.calls.filter((call) => call[0] === 'gateway:rpc');
    expect(gatewayRpcCalls.length).toBeGreaterThan(0);

    const agentCall = gatewayRpcCalls.find((call) => call[1] === 'agent');
    expect(agentCall).toBeTruthy();
    expect(agentCall?.[2]).toMatchObject({
      agentId: 'main',
      sessionKey: 'agent:main:main',
    });
  });

  it('wakes task owner agent session when assigned_session belongs to non-main agent', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke.mockImplementation(async (channel: unknown, ...args: unknown[]) => {
      if (channel === 'gateway:rpc') {
        const method = String(args[0] ?? '');
        if (method === 'agent') {
          return { success: true, result: { ok: true } };
        }
      }
      return { success: true, result: {} };
    });

    useTaskCenterStore.getState().handleGatewayNotification({
      method: 'task_needs_resume',
      params: {
        taskId: 'task-9',
        task: {
          id: 'task-9',
          goal: '跨 agent 恢复',
          status: 'running',
          progress: 0.7,
          plan_markdown: '- [x] a\n- [ ] b',
          created_at: 1,
          updated_at: 2,
          assigned_session: 'agent:ontology-expert:subagent:abc123',
        },
      },
    });

    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const gatewayRpcCalls = invoke.mock.calls.filter((call) => call[0] === 'gateway:rpc');
    const agentCall = gatewayRpcCalls.find((call) => call[1] === 'agent');
    expect(agentCall).toBeTruthy();
    expect(agentCall?.[2]).toMatchObject({
      agentId: 'ontology-expert',
      sessionKey: 'agent:ontology-expert:main',
    });
  });
});
