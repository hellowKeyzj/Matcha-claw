import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useGatewayStore } from '@/stores/gateway';
import { useTaskInboxStore } from '@/stores/task-inbox-store';
import { TaskInboxPanel } from '@/pages/Chat/components/TaskInboxPanel';
import i18n from '@/i18n';

const warningMock = vi.fn();

vi.mock('sonner', () => ({
  toast: {
    warning: (...args: unknown[]) => warningMock(...args),
    error: vi.fn(),
    success: vi.fn(),
  },
}));

describe('chat task inbox panel', () => {
  beforeEach(() => {
    warningMock.mockReset();
    i18n.changeLanguage('en');
    useGatewayStore.setState({
      status: { state: 'running', port: 18789 },
    } as never);
    useTaskInboxStore.setState({
      tasks: [],
      loading: false,
      initialized: true,
      error: null,
      workspaceDirs: [],
      workspaceLabel: null,
      submittingTaskIds: [],
      init: vi.fn(async () => {}),
      refreshTasks: vi.fn(async () => {}),
      submitDecision: vi.fn(async () => {}),
      submitFreeText: vi.fn(async () => {}),
      openTaskSession: vi.fn(() => ({ switched: true })),
      handleGatewayNotification: vi.fn(),
      clearError: vi.fn(),
    });
  });

  it('decision 模式渲染批准/拒绝按钮', () => {
    useTaskInboxStore.setState({
      tasks: [
        {
          id: 'task-1',
          goal: '审批决策任务',
          status: 'waiting_for_input',
          progress: 0.5,
          plan_markdown: '',
          created_at: 1,
          updated_at: 2,
          blocked_info: {
            reason: 'need_user_confirm',
            confirm_id: 'confirm-1',
            input_mode: 'decision',
            question: '是否批准？',
          },
        },
      ],
    });

    render(<TaskInboxPanel />);

    expect(screen.getByRole('button', { name: /Approve|批准/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reject|拒绝/ })).toBeInTheDocument();
  });

  it('free_text 模式渲染输入框并提交', async () => {
    const submitFreeText = vi.fn(async () => {});
    useTaskInboxStore.setState({
      tasks: [
        {
          id: 'task-2',
          goal: '补充输入任务',
          status: 'waiting_for_input',
          progress: 0.4,
          plan_markdown: '',
          created_at: 1,
          updated_at: 2,
          blocked_info: {
            reason: 'need_user_confirm',
            confirm_id: 'confirm-2',
            input_mode: 'free_text',
            question: '请输入批贷金额',
          },
        },
      ],
      submitFreeText,
    });

    render(<TaskInboxPanel />);

    const textbox = screen.getByRole('textbox');
    fireEvent.change(textbox, { target: { value: '批贷金额 500000，期限 24 个月' } });

    fireEvent.click(screen.getByRole('button', { name: /Submit Input|提交输入/ }));

    await waitFor(() => {
      expect(submitFreeText).toHaveBeenCalledWith({
        taskId: 'task-2',
        confirmId: 'confirm-2',
        userInput: '批贷金额 500000，期限 24 个月',
      });
    });
  });

  it('无 assigned_session 时提示先恢复任务', async () => {
    const openTaskSession = vi.fn(() => ({ switched: false, reason: 'missing_assigned_session' as const }));
    useTaskInboxStore.setState({
      tasks: [
        {
          id: 'task-3',
          goal: '无绑定会话',
          status: 'running',
          progress: 0.3,
          plan_markdown: '',
          created_at: 1,
          updated_at: 2,
        },
      ],
      openTaskSession,
    });

    render(<TaskInboxPanel />);

    fireEvent.click(screen.getByRole('button', { name: /Open Session|进入会话/ }));

    await waitFor(() => {
      expect(openTaskSession).toHaveBeenCalledWith('task-3');
      expect(warningMock).toHaveBeenCalled();
    });
  });

  it('收起态渲染展开按钮并可触发', () => {
    const onToggleCollapse = vi.fn();
    render(<TaskInboxPanel collapsed onToggleCollapse={onToggleCollapse} />);

    fireEvent.click(screen.getByRole('button', { name: /Expand task inbox|展开任务收件箱/ }));
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);
  });
});
