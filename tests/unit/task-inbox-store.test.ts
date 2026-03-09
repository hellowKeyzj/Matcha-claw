import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chat';
import { useTaskInboxStore } from '@/stores/task-inbox-store';

function resetTaskInboxState() {
  useTaskInboxStore.setState({
    tasks: [],
    loading: false,
    initialized: false,
    error: null,
    workspaceDirs: [],
    workspaceLabel: null,
    submittingTaskIds: [],
  });
}

describe('task inbox store', () => {
  beforeEach(() => {
    vi.mocked(window.electron.ipcRenderer.invoke).mockReset();
    resetTaskInboxState();
    useChatStore.setState({
      switchSession: vi.fn(),
    } as never);
  });

  it('跨 workspace 聚合并仅保留未完成任务', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke.mockImplementation(async (channel: unknown, ...args: unknown[]) => {
      if (channel === 'openclaw:getWorkspaceDir') {
        return 'E:/workspace/main';
      }
      if (channel === 'openclaw:getTaskWorkspaceDirs') {
        return ['E:/workspace/main', 'E:/workspace/agent-a'];
      }
      if (channel === 'gateway:rpc') {
        const method = String(args[0] ?? '');
        const params = (args[1] ?? {}) as { workspaceDir?: string };
        if (method === 'task_list' && params.workspaceDir === 'E:/workspace/main') {
          return {
            success: true,
            result: {
              tasks: [
                {
                  id: 'task-main-running',
                  goal: 'main running',
                  status: 'running',
                  progress: 0.4,
                  plan_markdown: '',
                  created_at: 1,
                  updated_at: 10,
                },
                {
                  id: 'task-main-done',
                  goal: 'main done',
                  status: 'completed',
                  progress: 1,
                  plan_markdown: '',
                  created_at: 1,
                  updated_at: 11,
                },
              ],
            },
          };
        }
        if (method === 'task_list' && params.workspaceDir === 'E:/workspace/agent-a') {
          return {
            success: true,
            result: {
              tasks: [
                {
                  id: 'task-agent-waiting',
                  goal: 'agent waiting',
                  status: 'waiting_for_input',
                  progress: 0.6,
                  plan_markdown: '',
                  created_at: 1,
                  updated_at: 12,
                  blocked_info: {
                    reason: 'need_user_confirm',
                    confirm_id: 'confirm-1',
                    input_mode: 'decision',
                    question: '是否批准？',
                  },
                },
              ],
            },
          };
        }
      }
      return { success: true, result: {} };
    });

    await useTaskInboxStore.getState().init();

    const state = useTaskInboxStore.getState();
    expect(state.initialized).toBe(true);
    expect(state.tasks.map((task) => task.id)).toEqual([
      'task-agent-waiting',
      'task-main-running',
    ]);
    expect(state.tasks[0].workspaceDir).toBe('E:/workspace/agent-a');
    expect(state.workspaceLabel).toBe('E:/workspace/main (+1)');
  });

  it('decision 恢复后会自动唤醒子会话', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke.mockImplementation(async (channel: unknown, ...args: unknown[]) => {
      if (channel !== 'gateway:rpc') {
        return { success: true, result: {} };
      }
      const method = String(args[0] ?? '');
      if (method === 'task_resume') {
        return {
          success: true,
          result: {
            task: {
              id: 'task-1',
              goal: '审批任务',
              status: 'running',
              progress: 0.7,
              plan_markdown: '',
              created_at: 1,
              updated_at: 20,
              assigned_session: 'agent:business-expert:subagent:abc',
            },
          },
        };
      }
      if (method === 'agent') {
        return { success: true, result: { ok: true } };
      }
      return { success: true, result: {} };
    });

    useTaskInboxStore.setState({
      tasks: [
        {
          id: 'task-1',
          goal: '审批任务',
          status: 'waiting_for_input',
          progress: 0.5,
          plan_markdown: '',
          created_at: 1,
          updated_at: 2,
          assigned_session: 'agent:business-expert:subagent:abc',
          workspaceDir: 'E:/workspace/main',
          blocked_info: {
            reason: 'need_user_confirm',
            confirm_id: 'confirm-1',
            input_mode: 'decision',
            question: '是否批准该贷款？',
          },
        },
      ],
    });

    await useTaskInboxStore.getState().submitDecision({
      taskId: 'task-1',
      confirmId: 'confirm-1',
      decision: 'approve',
    });

    const resumeCall = invoke.mock.calls.find(
      (call) => call[0] === 'gateway:rpc' && call[1] === 'task_resume',
    );
    expect(resumeCall?.[2]).toMatchObject({
      taskId: 'task-1',
      confirmId: 'confirm-1',
      decision: 'approve',
      userInput: 'yes',
      workspaceDir: 'E:/workspace/main',
    });

    const wakeCall = invoke.mock.calls.find(
      (call) => call[0] === 'gateway:rpc' && call[1] === 'agent',
    );
    expect(wakeCall?.[2]).toMatchObject({
      agentId: 'business-expert',
      sessionKey: 'agent:business-expert:main',
    });
  });

  it('优先跳转 assigned_session', () => {
    const switchSession = vi.fn();
    useChatStore.setState({
      switchSession: switchSession as never,
    } as never);
    useTaskInboxStore.setState({
      tasks: [
        {
          id: 'task-2',
          goal: '跳转会话',
          status: 'running',
          progress: 0.3,
          plan_markdown: '',
          created_at: 1,
          updated_at: 2,
          assigned_session: 'agent:ontology-expert:subagent:xyz',
        },
      ],
    });

    const result = useTaskInboxStore.getState().openTaskSession('task-2');

    expect(result).toEqual({ switched: true });
    expect(switchSession).toHaveBeenCalledWith('agent:ontology-expert:subagent:xyz');
  });

  it('未绑定会话时返回明确原因', () => {
    useTaskInboxStore.setState({
      tasks: [
        {
          id: 'task-3',
          goal: '未绑定',
          status: 'pending',
          progress: 0,
          plan_markdown: '',
          created_at: 1,
          updated_at: 1,
        },
      ],
    });

    const result = useTaskInboxStore.getState().openTaskSession('task-3');
    expect(result).toEqual({ switched: false, reason: 'missing_assigned_session' });
  });
});
