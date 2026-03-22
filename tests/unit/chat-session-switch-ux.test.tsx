import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Chat from '@/pages/Chat';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useChatStore } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import { useSubagentsStore } from '@/stores/subagents';
import { useTaskInboxStore } from '@/stores/task-inbox-store';
import i18n from '@/i18n';

describe('chat 会话切换 UI 回归', () => {
  let scrollIntoViewMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    i18n.changeLanguage('en');
    scrollIntoViewMock = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoViewMock,
    });

    const loadHistory = vi.fn().mockResolvedValue(undefined);
    const loadSessions = vi.fn().mockResolvedValue(undefined);

    useGatewayStore.setState({
      status: { state: 'running', port: 18789 },
    } as never);

    useSubagentsStore.setState({
      agents: [
        { id: 'test', name: 'Test Agent', workspace: '.', isDefault: false, createdAt: 1, updatedAt: 1 },
        { id: 'another', name: 'Another Agent', workspace: '.', isDefault: false, createdAt: 1, updatedAt: 1 },
      ],
      loadAgents: vi.fn().mockResolvedValue(undefined),
    } as never);

    useTaskInboxStore.setState({
      tasks: [],
      loading: false,
      initialized: true,
      error: null,
      workspaceDirs: [],
      workspaceLabel: null,
      submittingTaskIds: [],
      init: vi.fn().mockResolvedValue(undefined),
      refreshTasks: vi.fn().mockResolvedValue(undefined),
      submitDecision: vi.fn().mockResolvedValue(undefined),
      submitFreeText: vi.fn().mockResolvedValue(undefined),
      openTaskSession: vi.fn().mockReturnValue({ switched: false, reason: 'task_not_found' }),
      handleGatewayNotification: vi.fn(),
      clearError: vi.fn(),
    } as never);

    useChatStore.setState({
      messages: [
        {
          role: 'user',
          content: 'test pending message',
          timestamp: Date.now() / 1000,
          id: 'pending-user-msg',
        },
      ],
      loading: false,
      error: null,
      sending: true,
      activeRunId: 'run-test',
      streamingText: '',
      streamingMessage: { role: 'assistant', content: [{ type: 'thinking', thinking: 'processing' }] },
      streamingTools: [],
      pendingFinal: true,
      lastUserMessageAt: Date.now(),
      pendingToolImages: [],
      sessions: [
        { key: 'agent:test:main', displayName: 'agent:test:main' },
        { key: 'agent:another:main', displayName: 'agent:another:main' },
      ],
      currentSessionKey: 'agent:test:main',
      sessionLabels: {},
      sessionLastActivity: {},
      sessionRuntimeByKey: {},
      showThinking: true,
      thinkingLevel: null,
      loadHistory,
      loadSessions,
    } as never);
  });

  it('发送中切到其它会话再切回，应立即保留原会话消息并避免 Welcome 空白', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <TooltipProvider>
          <Chat />
        </TooltipProvider>
      </MemoryRouter>,
    );

    expect(screen.getByText('test pending message')).toBeInTheDocument();

    act(() => {
      useChatStore.getState().switchSession('agent:another:main');
    });
    expect(screen.getByText('MatchaClaw Chat')).toBeInTheDocument();

    act(() => {
      useChatStore.getState().switchSession('agent:test:main');
    });

    expect(screen.getByText('test pending message')).toBeInTheDocument();
    expect(screen.queryByText('MatchaClaw Chat')).not.toBeInTheDocument();
    expect(useChatStore.getState().sending).toBe(true);
    expect(useChatStore.getState().pendingFinal).toBe(true);
  });

  it('切换会话时即使当前未吸底也应滚到最新消息', async () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/']}>
        <TooltipProvider>
          <Chat />
        </TooltipProvider>
      </MemoryRouter>,
    );

    const viewport = container.querySelector('.overflow-y-auto') as HTMLDivElement | null;
    expect(viewport).toBeTruthy();
    if (!viewport) {
      return;
    }

    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 1200 });
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 320 });
    Object.defineProperty(viewport, 'scrollTop', { configurable: true, writable: true, value: 0 });

    scrollIntoViewMock.mockClear();
    fireEvent.scroll(viewport);

    act(() => {
      useChatStore.getState().switchSession('agent:another:main');
    });

    await waitFor(() => {
      expect(scrollIntoViewMock).toHaveBeenCalled();
    });
  });
});
