import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Chat from '@/pages/Chat';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useChatStore } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import { useSubagentsStore } from '@/stores/subagents';
import { useTaskInboxStore } from '@/stores/task-inbox-store';

let triggerResizeObserver: (() => void) | null = null;
let resizeObserverCallbacks: Array<() => void> = [];

class ResizeObserverStub {
  private readonly trigger: () => void;

  constructor(callback: ResizeObserverCallback) {
    this.trigger = () => {
      callback([], this as unknown as ResizeObserver);
    };
    resizeObserverCallbacks.push(this.trigger);
    triggerResizeObserver = () => {
      act(() => {
        for (const observerCallback of [...resizeObserverCallbacks]) {
          observerCallback();
        }
      });
    };
  }

  observe() {}
  unobserve() {}

  disconnect() {
    resizeObserverCallbacks = resizeObserverCallbacks.filter((callback) => callback !== this.trigger);
  }
}

function buildSessionMessages(count: number, prefix = 'session message') {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `${prefix} ${index + 1}`,
    timestamp: index + 1,
    id: `${prefix.replace(/\s+/g, '-')}-${index + 1}`,
  }));
}

function setupStores(options?: {
  currentMessages?: ReturnType<typeof buildSessionMessages>;
  currentHistoryMessages?: ReturnType<typeof buildSessionMessages>;
  sendMessage?: ReturnType<typeof vi.fn>;
}) {
  const currentMessages = options?.currentMessages ?? buildSessionMessages(35);
  const currentHistoryMessages = options?.currentHistoryMessages ?? currentMessages;
  const anotherLiveMessages = [
    {
      role: 'assistant',
      content: 'another live message',
      timestamp: 100,
      id: 'another-live-1',
    },
  ];
  const sendMessage = options?.sendMessage ?? vi.fn().mockResolvedValue(undefined);
  const loadHistory = vi.fn().mockResolvedValue(undefined);
  const loadSessions = vi.fn().mockResolvedValue(undefined);
  const rpc = vi.fn(async (method: string, params?: unknown) => {
    if (method === 'sessions.get') {
      const key = (params as { key?: string } | undefined)?.key;
      if (key === 'agent:test:main') {
        return { messages: currentHistoryMessages };
      }
      if (key === 'agent:another:main') {
        return { messages: buildSessionMessages(12, 'another history') };
      }
    }
    if (method === 'chat.history') {
      return { messages: [] };
    }
    return {};
  });

  useGatewayStore.setState({
    status: { state: 'running', port: 18789 },
    rpc,
  } as never);

  useSubagentsStore.setState({
    agents: [
      { id: 'test', name: 'Test Agent', workspace: '.', isDefault: false, createdAt: 1, updatedAt: 1 },
      { id: 'another', name: 'Another Agent', workspace: '.', isDefault: false, createdAt: 1, updatedAt: 1 },
    ],
    loadAgents: vi.fn().mockResolvedValue(undefined),
    updateAgent: vi.fn().mockResolvedValue(undefined),
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
    messages: currentMessages,
    snapshotReady: true,
    initialLoading: false,
    refreshing: false,
    mutating: false,
    error: null,
    sending: false,
    activeRunId: null,
    runPhase: 'idle',
    streamingMessage: null,
    streamRuntime: null,
    streamingTools: [],
    pendingFinal: false,
    lastUserMessageAt: Date.now(),
    pendingToolImages: [],
    approvalStatus: 'idle',
    pendingApprovalsBySession: {},
    sessions: [
      { key: 'agent:test:main', displayName: 'agent:test:main' },
      { key: 'agent:another:main', displayName: 'agent:another:main' },
    ],
    currentSessionKey: 'agent:test:main',
    sessionLabels: {},
    sessionLastActivity: {
      'agent:test:main': Date.now(),
      'agent:another:main': Date.now() - 1_000,
    },
    sessionReadyByKey: {
      'agent:test:main': true,
      'agent:another:main': true,
    },
    sessionRuntimeByKey: {
      'agent:another:main': {
        messages: anotherLiveMessages,
        sending: false,
        activeRunId: null,
        runPhase: 'idle',
        streamingMessage: null,
        streamRuntime: null,
        streamingTools: [],
        pendingFinal: false,
        lastUserMessageAt: null,
        pendingToolImages: [],
        approvalStatus: 'idle',
      },
    },
    showThinking: true,
    thinkingLevel: null,
    loadHistory,
    loadSessions,
    sendMessage,
  } as never);

  return { rpc, sendMessage };
}

function renderChat() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <TooltipProvider>
        <Chat />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

function installViewportMetrics(
  viewport: HTMLDivElement,
  metrics: { scrollHeight: number; clientHeight: number; scrollTop: number },
) {
  Object.defineProperty(viewport, 'scrollHeight', {
    configurable: true,
    get: () => metrics.scrollHeight,
  });
  Object.defineProperty(viewport, 'clientHeight', {
    configurable: true,
    get: () => metrics.clientHeight,
  });
  Object.defineProperty(viewport, 'scrollTop', {
    configurable: true,
    get: () => metrics.scrollTop,
    set: (value: number) => {
      metrics.scrollTop = value;
    },
  });
}

function installDynamicLayoutMetrics(
  viewport: HTMLDivElement,
  metrics: { scrollHeight: number; clientHeight: number; scrollTop: number },
) {
  installViewportMetrics(viewport, metrics);
  const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;

  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: function getBoundingClientRectPatched(this: HTMLElement) {
      if (this === viewport) {
        return {
          x: 0,
          y: 0,
          top: 0,
          bottom: metrics.clientHeight,
          left: 0,
          right: 800,
          width: 800,
          height: metrics.clientHeight,
          toJSON: () => ({}),
        };
      }
      if (this.dataset.chatRowKey && this.dataset.chatRowKind === 'message') {
        const rows = Array.from(
          viewport.querySelectorAll<HTMLElement>('[data-chat-row-key][data-chat-row-kind="message"]'),
        );
        const index = rows.indexOf(this);
        const top = index * 88 - metrics.scrollTop;
        return {
          x: 0,
          y: top,
          top,
          bottom: top + 72,
          left: 0,
          right: 800,
          width: 800,
          height: 72,
          toJSON: () => ({}),
        };
      }
      return originalGetBoundingClientRect.call(this);
    },
  });

  return () => {
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: originalGetBoundingClientRect,
    });
  };
}

describe('chat 历史投影切换', () => {
  beforeEach(() => {
    resizeObserverCallbacks = [];
    triggerResizeObserver = null;
    (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
    setupStores();
  });

  it('点击查看历史后应在同一聊天框加载 history，并保留输入框', async () => {
    renderChat();

    expect(screen.queryByText('session message 1')).toBeNull();
    expect(screen.getByPlaceholderText('Message (Type / to see skills, Enter to send, Shift+Enter for new line)')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'View history' }));

    await waitFor(() => {
      expect(screen.getByText('session message 1')).toBeInTheDocument();
    });

    expect(screen.getByText('session message 2')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Message (Type / to see skills, Enter to send, Shift+Enter for new line)')).toBeInTheDocument();
    expect(screen.queryByText('You are viewing read-only history mode. Return to live chat to keep talking.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Back to live' })).toBeNull();
  });

  it('在 history 里发送时应先回 live 再发送', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    setupStores({ sendMessage });
    const { container } = renderChat();

    fireEvent.click(screen.getByRole('button', { name: 'View history' }));

    await waitFor(() => {
      expect(screen.getByText('session message 1')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText('Message (Type / to see skills, Enter to send, Shift+Enter for new line)'), {
      target: { value: 'reply from history' },
    });
    fireEvent.click(container.querySelector('button[title="Send"]') as HTMLButtonElement);

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith('reply from history', undefined);
    });

    await waitFor(() => {
      expect(screen.queryByText('session message 1')).toBeNull();
    });

    expect(screen.getByText('session message 35')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View history' })).toBeInTheDocument();
  });

  it('点击查看历史后应按锚点恢复，不跳到历史底部', async () => {
    const { container } = renderChat();
    const viewport = container.querySelector('.overflow-y-auto') as HTMLDivElement;
    const metrics = {
      scrollHeight: 30 * 88,
      clientHeight: 320,
      scrollTop: 176,
    };
    const restoreLayoutMetrics = installDynamicLayoutMetrics(viewport, metrics);

    try {
      fireEvent.click(screen.getByRole('button', { name: 'View history' }));

      await waitFor(() => {
        expect(screen.getByText('session message 1')).toBeInTheDocument();
      });

      metrics.scrollHeight = 35 * 88;
      act(() => {
        triggerResizeObserver?.();
      });

      await waitFor(() => {
        expect(metrics.scrollTop).toBe(616);
      });
    } finally {
      restoreLayoutMetrics();
    }
  });

  it('history 里缺少同 messageId 时应按时间邻近消息恢复锚点', async () => {
    const currentMessages = buildSessionMessages(35);
    const currentHistoryMessages = currentMessages.map(({ id, ...message }) => ({ ...message }));
    setupStores({ currentMessages, currentHistoryMessages });
    const { container } = renderChat();
    const viewport = container.querySelector('.overflow-y-auto') as HTMLDivElement;
    const metrics = {
      scrollHeight: 30 * 88,
      clientHeight: 320,
      scrollTop: 176,
    };
    const restoreLayoutMetrics = installDynamicLayoutMetrics(viewport, metrics);

    try {
      fireEvent.click(screen.getByRole('button', { name: 'View history' }));

      await waitFor(() => {
        expect(screen.getByText('session message 1')).toBeInTheDocument();
      });

      metrics.scrollHeight = 35 * 88;
      act(() => {
        triggerResizeObserver?.();
      });

      await waitFor(() => {
        expect(metrics.scrollTop).toBe(616);
      });
    } finally {
      restoreLayoutMetrics();
    }
  });

  it('切会话时应默认回到 live 投影', async () => {
    renderChat();

    fireEvent.click(screen.getByRole('button', { name: 'View history' }));
    await waitFor(() => {
      expect(screen.getByText('session message 1')).toBeInTheDocument();
    });

    act(() => {
      useChatStore.getState().switchSession('agent:another:main');
    });

    await waitFor(() => {
      expect(screen.getByText('another live message')).toBeInTheDocument();
    });

    expect(screen.queryByText('session message 1')).toBeNull();
  });
});
