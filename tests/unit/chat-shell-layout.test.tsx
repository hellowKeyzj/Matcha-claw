import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChatShell } from '@/pages/Chat/components/ChatShell';
import { TaskInboxPanel } from '@/pages/Chat/components/TaskInboxPanel';

vi.mock('@/components/layout/VerticalPaneResizer', () => ({
  VerticalPaneResizer: ({ testId, className }: { testId?: string; className?: string }) => (
    <div data-testid={testId} className={className} />
  ),
}));

vi.mock('@/pages/Chat/ChatInput', () => ({
  ChatInput: () => <div data-testid="chat-input" />,
}));

vi.mock('@/pages/Chat/components/AgentSkillConfigDialog', () => ({
  AgentSkillConfigDialog: () => null,
}));

vi.mock('@/pages/Chat/components/ChatHeaderBar', () => ({
  ChatHeaderBar: () => <div data-testid="chat-header" />,
}));

vi.mock('@/pages/Chat/components/ChatRuntimeDock', () => ({
  ChatApprovalDock: () => <div data-testid="chat-approval-dock" />,
  ChatErrorBanner: () => <div data-testid="chat-error-banner" />,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'taskInbox.unfinishedCount') {
        return `count:${String(options?.count ?? 0)}`;
      }
      return key;
    },
  }),
}));

vi.mock('@/stores/gateway', () => ({
  useGatewayStore: (selector: (state: { status: { state: string } }) => unknown) => selector({
    status: { state: 'running' },
  }),
}));

vi.mock('@/stores/task-inbox-store', () => ({
  useTaskInboxStore: (selector: (state: {
    tasks: unknown[];
    loading: boolean;
    initialized: boolean;
    error: string | null;
    workspaceLabel: string | null;
    init: () => Promise<void>;
    refreshTasks: () => Promise<void>;
    openTaskSession: () => { switched: boolean };
    clearError: () => void;
  }) => unknown) => selector({
    tasks: [],
    loading: false,
    initialized: true,
    error: null,
    workspaceLabel: null,
    init: vi.fn().mockResolvedValue(undefined),
    refreshTasks: vi.fn().mockResolvedValue(undefined),
    openTaskSession: vi.fn(() => ({ switched: true })),
    clearError: vi.fn(),
  }),
}));

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
  },
}));

describe('chat shell layout model', () => {
  it('uses a single task inbox split-pane model without xl breakpoint gating', () => {
    const { container } = render(
      <ChatShell
        chatLayoutRef={{ current: null }}
        taskInboxCollapsed={false}
        taskInboxWidth={360}
        taskInboxResizerWidth={6}
        onTaskInboxResizeStart={vi.fn()}
        onToggleTaskInbox={vi.fn()}
        headerProps={{} as never}
        threadPanel={<div data-testid="thread-panel" />}
        errorBannerProps={null}
        approvalDockProps={null}
        inputProps={{} as never}
        skillDialogProps={{} as never}
      />,
    );

    const shell = container.firstElementChild as HTMLElement | null;
    expect(shell?.className).toContain('[grid-template-columns:minmax(0,1fr)_var(--task-inbox-resizer-width)_var(--task-inbox-width)]');
    expect(shell?.className).not.toContain('xl:[grid-template-columns');
    expect(screen.getByTestId('chat-right-resizer')).toHaveClass('block');
  });

  it('keeps the task inbox on the right rail instead of the stacked border-top layout', () => {
    const { rerender } = render(
      <TaskInboxPanel collapsed={false} onToggleCollapse={vi.fn()} />,
    );

    expect(screen.getByTestId('chat-task-inbox-panel').className).toContain('border-l');
    expect(screen.getByTestId('chat-task-inbox-panel').className).not.toContain('border-t');
    expect(screen.getByTestId('chat-task-inbox-panel').className).not.toContain('xl:');

    rerender(<TaskInboxPanel collapsed onToggleCollapse={vi.fn()} />);

    expect(screen.getByTestId('chat-task-inbox-panel').className).toContain('border-l');
    expect(screen.getByTestId('chat-task-inbox-panel').className).not.toContain('border-t');
    expect(screen.getByTestId('chat-task-inbox-panel').className).not.toContain('xl:');
  });
});
