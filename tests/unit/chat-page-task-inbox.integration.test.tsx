import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Chat } from '@/pages/Chat';
import { useGatewayStore } from '@/stores/gateway';
import { useChatStore } from '@/stores/chat';
import { useTaskInboxStore } from '@/stores/task-inbox-store';
import { TooltipProvider } from '@/components/ui/tooltip';
import i18n from '@/i18n';

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
  });

  it('在 Chat 页面渲染右侧任务收件箱', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
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
        <TooltipProvider>
          <Chat />
        </TooltipProvider>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: /Collapse task inbox/i }));
    expect(screen.getByRole('button', { name: /Expand task inbox/i })).toBeInTheDocument();
  });
});
