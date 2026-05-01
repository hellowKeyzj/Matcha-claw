import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ChatShell } from '@/pages/Chat/components/ChatShell';
import { ChatSidePanel } from '@/pages/Chat/components/ChatSidePanel';

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

vi.mock('@/stores/task-inbox-store', () => ({
  useTaskInboxStore: (selector: (state: {
    tasks: Array<{ id: string; subject?: string; status: string; workspaceDir?: string }>;
    loading: boolean;
    initialized: boolean;
    error: string | null;
    workspaceLabel: string | null;
    openTaskSession: () => { switched: boolean };
    clearError: () => void;
    refreshTasks: () => Promise<void>;
  }) => unknown) => selector({
    tasks: [],
    loading: false,
    initialized: true,
    error: null,
    workspaceLabel: 'C:/Users/Mr.Key/.openclaw/workspace (+5)',
    openTaskSession: vi.fn(() => ({ switched: true })),
    clearError: vi.fn(),
    refreshTasks: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('@/stores/gateway', () => ({
  useGatewayStore: (selector: (state: { status: { state: string } }) => unknown) => selector({
    status: { state: 'running' },
  }),
}));

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
  },
}));

describe('chat shell task inbox layout', () => {
  const skillConfigProps = {
    skillConfigLabel: 'skill-config',
    skillConfigTitle: 'skill-config · main',
    skillOptions: [
      { id: 'skill-a', name: 'Skill A', icon: 'A' },
      { id: 'skill-b', name: 'Skill B', icon: 'B' },
    ],
    skillsLoading: false,
    selectedSkillIds: ['skill-a'],
    onToggleSkill: vi.fn(),
  };

  it('uses a single-column stage when the chat side panel is closed', () => {
    const { container } = render(
      <ChatShell
        chatLayoutRef={{ current: null }}
        sidePanelOpen={false}
        sidePanelMode="hidden"
        sidePanelWidth={0}
        isEmptyState={false}
        emptyState={null}
        sidePanel={<div data-testid="chat-side-panel" />}
        header={<div data-testid="chat-header" />}
        viewportPane={<div data-testid="thread-panel" />}
        errorBanner={null}
        approvalDock={null}
        input={<div data-testid="chat-input" />}
      />,
    );

    const shell = container.firstElementChild as HTMLElement | null;
    expect(shell?.className).toContain('[grid-template-columns:minmax(0,1fr)]');
    expect(shell?.className).not.toContain('_52px]');
    expect(screen.queryByTestId('chat-side-panel')).toBeNull();
    expect(screen.getByTestId('chat-stage-header-overlay').firstElementChild?.className).toContain('pointer-events-none');
    expect(screen.getByTestId('chat-header').parentElement?.className).toContain('pointer-events-auto');
  });

  it('adds a right panel column only when the chat side panel is docked open', () => {
    const { container } = render(
      <ChatShell
        chatLayoutRef={{ current: null }}
        sidePanelOpen
        sidePanelMode="docked"
        sidePanelWidth={360}
        isEmptyState={false}
        emptyState={null}
        sidePanel={<div data-testid="chat-side-panel" data-mode="docked" />}
        header={<div data-testid="chat-header" />}
        viewportPane={<div data-testid="thread-panel" />}
        errorBanner={null}
        approvalDock={null}
        input={<div data-testid="chat-input" />}
      />,
    );

    const shell = container.firstElementChild as HTMLElement | null;
    expect(shell?.className).toContain('[grid-template-columns:minmax(0,1fr)_var(--chat-side-panel-width)]');
    expect(screen.getByTestId('chat-side-panel')).toHaveAttribute('data-mode', 'docked');
    expect(screen.queryByTestId('chat-right-resizer')).toBeNull();
  });

  it('renders the chat side panel as an overlay when requested', () => {
    render(
      <ChatShell
        chatLayoutRef={{ current: null }}
        sidePanelOpen
        sidePanelMode="overlay"
        sidePanelWidth={320}
        isEmptyState={false}
        emptyState={null}
        sidePanel={<div data-testid="chat-side-panel" data-mode="overlay" />}
        header={<div data-testid="chat-header" />}
        viewportPane={<div data-testid="thread-panel" />}
        errorBanner={null}
        approvalDock={null}
        input={<div data-testid="chat-input" />}
      />,
    );

    expect(screen.getByTestId('chat-side-panel-overlay')).toBeInTheDocument();
    expect(screen.getByTestId('chat-side-panel')).toHaveAttribute('data-mode', 'overlay');
  });

  it('renders task and skill tabs inside one shared side panel shell', () => {
    const onTabChange = vi.fn();
    render(
      <ChatSidePanel
        mode="docked"
        width={360}
        activeTab="tasks"
        onTabChange={onTabChange}
        onClose={vi.fn()}
        unfinishedTaskCount={0}
        {...skillConfigProps}
      />,
    );

    expect(screen.getByRole('tab', { name: 'taskInbox.title' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'skill-config' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'taskInbox.collapse' })).toBeInTheDocument();
    expect(screen.queryByTitle('taskInbox.expand')).toBeNull();
    expect(screen.getByTestId('chat-side-panel').className).toContain('border-l');
    expect(screen.queryByText(/workspace/i)).toBeNull();
    expect(screen.queryByText(/mr\.key/i)).toBeNull();
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'skill-config' }));
    expect(onTabChange).toHaveBeenCalledWith('skills');
  });

  it('renders the inline skill configuration content inside the shared side panel', () => {
    render(
      <ChatSidePanel
        mode="overlay"
        width={320}
        activeTab="skills"
        onTabChange={vi.fn()}
        onClose={vi.fn()}
        unfinishedTaskCount={0}
        {...skillConfigProps}
      />,
    );

    expect(screen.getByText('skill-config · main')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Skill A' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'skillConfigDialog.save' })).toBeNull();
    expect(screen.getByRole('tabpanel').className).toContain('data-[state=active]:flex');
  });

  it('renders empty-state content in the stage center instead of the bottom composer overlay', () => {
    render(
      <ChatShell
        chatLayoutRef={{ current: null }}
        sidePanelOpen={false}
        sidePanelMode="hidden"
        sidePanelWidth={0}
        isEmptyState
        emptyState={<div data-testid="chat-empty-state"><div data-testid="chat-input" /></div>}
        sidePanel={<div data-testid="chat-side-panel" />}
        header={<div data-testid="chat-header" />}
        viewportPane={<div data-testid="thread-panel" />}
        errorBanner={null}
        approvalDock={null}
        input={<div data-testid="chat-bottom-input" />}
      />,
    );

    expect(screen.getByTestId('chat-empty-state')).toBeInTheDocument();
    expect(screen.queryByTestId('thread-panel')).toBeNull();
    expect(screen.queryByTestId('chat-stage-bottom-fade')).toBeNull();
    const centeredHost = screen.getByTestId('chat-empty-state').parentElement as HTMLElement | null;
    expect(centeredHost?.className).toContain('items-center');
    expect(screen.queryByTestId('chat-bottom-input')).toBeNull();
  });

  it('recomputes composer safe offset when the stage switches from empty state back to normal chat mode', () => {
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function mockRect(this: HTMLElement) {
      if (typeof this.className === 'string' && this.className.includes('absolute inset-x-0 bottom-0 z-20')) {
        return DOMRect.fromRect({
          x: 0,
          y: 0,
          width: 640,
          height: 132,
        });
      }
      return DOMRect.fromRect({
        x: 0,
        y: 0,
        width: 0,
        height: 0,
      });
    });

    try {
      const { container, rerender } = render(
        <ChatShell
          chatLayoutRef={{ current: null }}
          sidePanelOpen={false}
          sidePanelMode="hidden"
          sidePanelWidth={0}
          isEmptyState
          emptyState={<div data-testid="chat-empty-state"><div data-testid="chat-input" /></div>}
          sidePanel={<div data-testid="chat-side-panel" />}
          header={<div data-testid="chat-header" />}
          viewportPane={<div data-testid="thread-panel" />}
          errorBanner={null}
          approvalDock={null}
          input={<div data-testid="chat-bottom-input" />}
        />,
      );

      const stage = container.querySelector('.chat-scroll-sync') as HTMLElement | null;
      expect(stage?.style.getPropertyValue('--chat-composer-safe-offset')).toBe('0px');
      expect(stage?.style.getPropertyValue('--chat-thread-bottom-padding')).toBe('12px');

      rerender(
        <ChatShell
          chatLayoutRef={{ current: null }}
          sidePanelOpen={false}
          sidePanelMode="hidden"
          sidePanelWidth={0}
          isEmptyState={false}
          emptyState={null}
          sidePanel={<div data-testid="chat-side-panel" />}
          header={<div data-testid="chat-header" />}
          viewportPane={<div data-testid="thread-panel" />}
          errorBanner={null}
          approvalDock={null}
          input={<div data-testid="chat-bottom-input" />}
        />,
      );

      expect(stage?.style.getPropertyValue('--chat-composer-safe-offset')).toBe('132px');
      expect(stage?.style.getPropertyValue('--chat-thread-bottom-padding')).toBe('144px');
    } finally {
      rectSpy.mockRestore();
    }
  });
});
