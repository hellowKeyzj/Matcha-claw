import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { Chat } from '@/pages/Chat';
import { useGatewayStore } from '@/stores/gateway';
import { useChatStore } from '@/stores/chat';
import { useTaskInboxStore } from '@/stores/task-inbox-store';
import { useSubagentsStore } from '@/stores/subagents';
import { TooltipProvider } from '@/components/ui/tooltip';
import i18n from '@/i18n';

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="router-location">{`${location.pathname}${location.search}`}</div>;
}

describe('chat page + task inbox integration', () => {
  beforeEach(() => {
    i18n.changeLanguage('en');
    HTMLElement.prototype.scrollIntoView = vi.fn();
    window.localStorage.setItem('chat:task-inbox-collapsed', '0');
    useGatewayStore.setState({
      status: { state: 'running', port: 18789 },
    } as never);

    useChatStore.setState({
      messages: [],
      loading: false,
      sending: false,
      error: null,
      showThinking: true,
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      loadHistory: vi.fn(async () => {}),
      loadSessions: vi.fn(async () => {}),
      switchSession: vi.fn(),
      sendMessage: vi.fn(async () => {}),
      abortRun: vi.fn(async () => {}),
      clearError: vi.fn(),
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

    useSubagentsStore.setState({
      agents: [
        {
          id: 'main',
          name: 'Main',
          model: 'openai/gpt-4.1-mini',
          isDefault: true,
        },
      ],
    } as never);
  });

  it('在 Chat 页面渲染右侧任务收件箱', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <LocationProbe />
        <TooltipProvider>
          <Chat />
        </TooltipProvider>
      </MemoryRouter>,
    );

    expect(screen.getByTestId('chat-task-inbox-panel')).toBeInTheDocument();
  });

  it('支持在 Chat 页面收起并展开任务收件箱', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <LocationProbe />
        <TooltipProvider>
          <Chat />
        </TooltipProvider>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: /Collapse task inbox/i }));
    expect(screen.getByRole('button', { name: /Expand task inbox/i })).toBeInTheDocument();
  });

  it('主 Agent 无模型时阻断聊天入口', () => {
    useSubagentsStore.setState({
      agents: [
        {
          id: 'main',
          name: 'Main',
          model: undefined,
          isDefault: true,
        },
      ],
    } as never);

    render(
      <MemoryRouter initialEntries={['/']}>
        <LocationProbe />
        <TooltipProvider>
          <Chat />
        </TooltipProvider>
      </MemoryRouter>,
    );

    expect(screen.getByText('Main Agent Model Is Not Configured')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByTestId('router-location')).toHaveTextContent('/settings?section=aiProviders');
  });
});
