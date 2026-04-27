import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Chat from '@/pages/Chat';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useChatStore } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import { useSubagentsStore } from '@/stores/subagents';
import { useTaskInboxStore } from '@/stores/task-inbox-store';
import { createEmptySessionRecord } from '@/stores/chat/store-state-helpers';

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

function buildSessionRecord(overrides?: Partial<ReturnType<typeof createEmptySessionRecord>>) {
  const base = createEmptySessionRecord();
  return {
    transcript: overrides?.transcript ?? base.transcript,
    meta: {
      ...base.meta,
      ...overrides?.meta,
    },
    runtime: {
      ...base.runtime,
      ...overrides?.runtime,
    },
  };
}

function setupStores(options?: {
  currentMessages?: ReturnType<typeof buildSessionMessages>;
  currentHistoryMessages?: ReturnType<typeof buildSessionMessages>;
  sendMessage?: ReturnType<typeof vi.fn>;
  currentSessionKey?: string;
  anotherSessionKey?: string;
}) {
  const currentMessages = options?.currentMessages ?? buildSessionMessages(35);
  const currentHistoryMessages = options?.currentHistoryMessages ?? currentMessages;
  const currentSessionKey = options?.currentSessionKey ?? 'agent:test:main';
  const anotherSessionKey = options?.anotherSessionKey ?? 'agent:another:main';
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
      if (key === currentSessionKey) {
        return { messages: currentHistoryMessages };
      }
      if (key === anotherSessionKey) {
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
    snapshotReady: true,
    initialLoading: false,
    refreshing: false,
    mutating: false,
    error: null,
    pendingApprovalsBySession: {},
    sessions: [
      { key: currentSessionKey, displayName: currentSessionKey },
      { key: anotherSessionKey, displayName: anotherSessionKey },
    ],
    currentSessionKey,
    sessionsByKey: {
      [currentSessionKey]: buildSessionRecord({
        transcript: currentMessages,
        meta: {
          ready: true,
          lastActivityAt: Date.now(),
        },
      }),
      [anotherSessionKey]: buildSessionRecord({
        transcript: anotherLiveMessages,
        meta: {
          ready: true,
          lastActivityAt: Date.now() - 1_000,
        },
      }),
    },
    showThinking: true,
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

  it('history 投影应并入 live 已有但远端历史还没返回的最新消息', async () => {
    const currentMessages = buildSessionMessages(35);
    const currentHistoryMessages = currentMessages.slice(0, 32);
    setupStores({ currentMessages, currentHistoryMessages });
    renderChat();

    fireEvent.click(screen.getByRole('button', { name: 'View history' }));

    await waitFor(() => {
      expect(screen.getByText('session message 1')).toBeInTheDocument();
    });

    expect(screen.getByText('session message 35')).toBeInTheDocument();
    expect(screen.getByText('session message 34')).toBeInTheDocument();
    expect(screen.getByText('session message 33')).toBeInTheDocument();
  });

  it('history 投影不应混入 runtime streaming 内容', async () => {
    setupStores();
    useChatStore.setState({
      sessionsByKey: {
        ...useChatStore.getState().sessionsByKey,
        'agent:test:main': buildSessionRecord({
          transcript: buildSessionMessages(35),
          meta: {
            ready: true,
            lastActivityAt: Date.now(),
          },
          runtime: {
            sending: true,
            pendingFinal: true,
            activeRunId: 'run-current',
            assistantOverlay: {
              runId: 'run-current',
              messageId: 'streaming-assistant',
              sourceMessage: {
                role: 'assistant',
                content: 'live partial answer',
                timestamp: Date.now() / 1000,
                id: 'streaming-assistant',
              },
              committedText: 'live partial answer',
              targetText: 'live partial answer',
              status: 'streaming',
              rafId: null,
            },
          },
        }),
      },
    } as never);

    renderChat();

    fireEvent.click(screen.getByRole('button', { name: 'View history' }));

    await waitFor(() => {
      expect(screen.getByText('session message 1')).toBeInTheDocument();
    });

    expect(screen.queryByText('live partial answer')).toBeNull();
  });

  it('远端历史补齐后，history 投影应最终收敛到完整历史底稿', async () => {
    const currentMessages = buildSessionMessages(35);
    let remoteHistoryMessages = currentMessages.slice(0, 32);
    const rpc = vi.fn(async (method: string, params?: unknown) => {
      if (method === 'sessions.get') {
        const key = (params as { key?: string } | undefined)?.key;
        if (key === 'agent:test:main') {
          return { messages: remoteHistoryMessages };
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

    setupStores({ currentMessages, currentHistoryMessages: remoteHistoryMessages });
    useGatewayStore.setState({
      status: { state: 'running', port: 18789 },
      rpc,
    } as never);

    renderChat();

    fireEvent.click(screen.getByRole('button', { name: 'View history' }));
    await waitFor(() => {
      expect(screen.getByText('session message 35')).toBeInTheDocument();
    });

    act(() => {
      useChatStore.getState().switchSession('agent:another:main');
    });
    await waitFor(() => {
      expect(screen.getByText('another live message')).toBeInTheDocument();
    });

    remoteHistoryMessages = currentMessages;

    act(() => {
      useChatStore.getState().switchSession('agent:test:main');
    });
    await waitFor(() => {
      expect(screen.getByText('session message 35')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'View history' }));
    await waitFor(() => {
      expect(rpc.mock.calls.filter(([method, params]) => (
        method === 'sessions.get'
        && (params as { key?: string } | undefined)?.key === 'agent:test:main'
      )).length).toBeGreaterThanOrEqual(2);
    });

    act(() => {
      useChatStore.setState({
        sessionsByKey: {
          ...useChatStore.getState().sessionsByKey,
          'agent:test:main': buildSessionRecord({
            transcript: currentMessages.slice(0, 32),
            meta: {
              ready: true,
              lastActivityAt: Date.now(),
            },
          }),
        },
      } as never);
    });

    await waitFor(() => {
      expect(screen.getByText('session message 35')).toBeInTheDocument();
    });
    expect(screen.getAllByText('session message 35')).toHaveLength(1);
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

  it('history cache 缺少锚点消息时，刷新补齐前后都应持续使用原始 live 锚点', async () => {
    const currentSessionKey = 'agent:test-history-anchor:main';
    const anotherSessionKey = 'agent:test-history-anchor:secondary';
    const currentMessages = buildSessionMessages(35);
    const cachedHistoryMessages = currentMessages.filter((message) => message.id !== 'session-message-8');
    setupStores({
      currentMessages,
      currentHistoryMessages: cachedHistoryMessages,
      currentSessionKey,
      anotherSessionKey,
    });

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

      metrics.scrollHeight = 34 * 88;
      act(() => {
        triggerResizeObserver?.();
      });

      await waitFor(() => {
        expect(screen.getByText('session message 1')).toBeInTheDocument();
        expect(metrics.scrollTop).toBe(528);
      });

      act(() => {
        useChatStore.getState().switchSession(anotherSessionKey);
      });

      await waitFor(() => {
        expect(screen.getByText('another live message')).toBeInTheDocument();
      });

      act(() => {
        useChatStore.getState().switchSession(currentSessionKey);
      });

      await waitFor(() => {
        expect(screen.queryByText('session message 1')).toBeNull();
      });

      metrics.scrollHeight = 30 * 88;
      metrics.scrollTop = 176;

      let resolveFullHistory: ((value: { messages: typeof currentMessages }) => void) | null = null;
      const fullHistoryPromise = new Promise<{ messages: typeof currentMessages }>((resolve) => {
        resolveFullHistory = resolve;
      });
      const refreshRpc = vi.fn(async (method: string, params?: unknown) => {
        if (method === 'sessions.get') {
          const key = (params as { key?: string } | undefined)?.key;
          if (key === currentSessionKey) {
            return fullHistoryPromise;
          }
          if (key === anotherSessionKey) {
            return { messages: buildSessionMessages(12, 'another history') };
          }
        }
        if (method === 'chat.history') {
          return { messages: [] };
        }
        return {};
      });
      act(() => {
        useGatewayStore.setState({
          status: { state: 'running', port: 18789 },
          rpc: refreshRpc,
        } as never);
      });

      fireEvent.click(screen.getByRole('button', { name: 'View history' }));

      metrics.scrollHeight = 34 * 88;
      act(() => {
        triggerResizeObserver?.();
      });

      await waitFor(() => {
        expect(screen.queryByText('session message 8')).toBeNull();
        expect(metrics.scrollTop).toBe(528);
      });

      await act(async () => {
        resolveFullHistory?.({ messages: currentMessages });
      });

      await waitFor(() => {
        expect(screen.getByText('session message 8')).toBeInTheDocument();
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
