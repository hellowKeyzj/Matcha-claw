import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AgentSessionsPane } from '@/components/layout/AgentSessionsPane';
import Chat from '@/pages/Chat';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useChatStore } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import { useSubagentsStore } from '@/stores/subagents';
import { useTaskInboxStore } from '@/stores/task-inbox-store';
import i18n from '@/i18n';

const scrollToIndexMock = vi.fn();
let lastNotifiedCount: number | null = null;

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({
    count,
    onChange,
  }: {
    count: number;
    onChange?: (instance: { scrollToIndex: typeof scrollToIndexMock }, sync: boolean) => void;
  }) => {
    const instance = {
      getVirtualItems: () => Array.from({ length: count }, (_, index) => ({
        index,
        key: `virtual-item-${index}`,
        start: index * 120,
        size: 120,
      })),
      getTotalSize: () => count * 120,
      measureElement: vi.fn(),
      scrollToIndex: scrollToIndexMock,
    };

    // 模拟更接近真实 virtualizer 的行为：
    // 如果切会话前后可视范围没有变化，就不会“每次 render 都触发 onChange”。
    if (lastNotifiedCount !== count) {
      lastNotifiedCount = count;
      onChange?.(instance, false);
    }
    return instance;
  },
}));

function findClosestScrollViewport(node: HTMLElement | null): HTMLDivElement | null {
  let current = node?.parentElement ?? null;
  while (current) {
    if (typeof current.className === 'string' && current.className.includes('overflow-y-auto')) {
      return current as HTMLDivElement;
    }
    current = current.parentElement;
  }
  return null;
}

describe('chat 左侧点击链路回归', () => {
  beforeEach(() => {
    i18n.changeLanguage('en');
    scrollToIndexMock.mockReset();
    lastNotifiedCount = null;

    useGatewayStore.setState({
      status: { state: 'running', port: 18789 },
    } as never);

    useSubagentsStore.setState({
      agents: [
        { id: 'main', name: 'main', workspace: '.', isDefault: true, createdAt: 1, updatedAt: 1 },
        { id: 'another', name: 'another', workspace: '.', isDefault: false, createdAt: 1, updatedAt: 1 },
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
          content: 'current session user message',
          timestamp: 1,
          id: 'current-msg-1',
        },
        {
          role: 'assistant',
          content: 'current session mid message',
          timestamp: 2,
          id: 'current-msg-2',
        },
        {
          role: 'assistant',
          content: 'current session old message',
          timestamp: 3,
          id: 'current-msg-3',
        },
      ],
      snapshotReady: true,
      initialLoading: false,
      refreshing: false,
      mutating: false,
      error: null,
      sending: false,
      activeRunId: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      approvalStatus: 'idle',
      sessions: [
        { key: 'agent:main:main', displayName: 'agent:main:main' },
        { key: 'agent:another:main', displayName: 'agent:another:main' },
      ],
      currentSessionKey: 'agent:main:main',
      sessionLabels: {
        'agent:another:main': 'another latest session',
      },
      sessionLastActivity: {
        'agent:another:main': 3,
      },
      sessionRuntimeByKey: {
        'agent:another:main': {
          messages: [
            {
              role: 'user',
              content: 'another user message',
              timestamp: 1,
              id: 'another-msg-1',
            },
            {
              role: 'assistant',
              content: 'another assistant mid message',
              timestamp: 2,
              id: 'another-msg-2',
            },
            {
              role: 'assistant',
              content: 'another assistant latest message',
              timestamp: 3,
              id: 'another-msg-3',
            },
          ],
          sending: false,
          activeRunId: null,
          streamingText: '',
          streamingMessage: null,
          streamingTools: [],
          pendingFinal: false,
          lastUserMessageAt: null,
          pendingToolImages: [],
          approvalStatus: 'idle',
        },
      },
      showThinking: true,
      thinkingLevel: null,
      loadHistory: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);
  });

  it('用户先上翻当前会话，再点击左侧 AGENT 时，仍应落到目标会话最新消息底部', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <TooltipProvider>
          <div className="flex h-screen">
            <AgentSessionsPane />
            <div className="min-h-0 flex-1">
              <Chat />
            </div>
          </div>
        </TooltipProvider>
      </MemoryRouter>,
    );

    const currentMessage = screen.getByText('current session old message');
    const viewport = findClosestScrollViewport(currentMessage as HTMLElement);
    expect(viewport).toBeTruthy();
    if (!viewport) {
      return;
    }

    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 2200 });
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 320 });
    Object.defineProperty(viewport, 'scrollTop', { configurable: true, writable: true, value: 0 });

    fireEvent.scroll(viewport);
    scrollToIndexMock.mockClear();

    fireEvent.click(screen.getByTestId('agent-item-another'));

    await waitFor(() => {
      expect(screen.getByText('another assistant latest message')).toBeInTheDocument();
      expect(scrollToIndexMock).toHaveBeenCalledWith(2, { align: 'end' });
    });
  });
});
