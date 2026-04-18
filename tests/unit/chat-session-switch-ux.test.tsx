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

const trackUiEventMock = vi.fn();
const scrollToIndexMock = vi.fn();
const scrollToOffsetMock = vi.fn();
const VIRTUAL_WINDOW_SIZE = 10;
let virtualWindowStartIndex = 0;
let triggerResizeObserver: (() => void) | null = null;
let resizeObserverCallbacks: Array<() => void> = [];

function hasTelemetryEvent(
  event: string,
  matcher?: (payload: Record<string, unknown>) => boolean,
): boolean {
  return trackUiEventMock.mock.calls.some((call) => {
    if (call[0] !== event) {
      return false;
    }
    const payload = (call[1] ?? {}) as Record<string, unknown>;
    return matcher ? matcher(payload) : true;
  });
}

vi.mock('@/lib/telemetry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/telemetry')>();
  return {
    ...actual,
    trackUiEvent: (...args: unknown[]) => trackUiEventMock(...args),
  };
});

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

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({
    count,
    onChange,
  }: {
    count: number;
    onChange?: (instance: { scrollToIndex: typeof scrollToIndexMock }, sync: boolean) => void;
  }) => {
    const getClampedStartIndex = () => {
      if (count <= 0) {
        return 0;
      }
      return Math.min(
        Math.max(0, virtualWindowStartIndex),
        Math.max(0, count - 1),
      );
    };

    const instance = {
      getVirtualItems: () => {
        const start = getClampedStartIndex();
        const end = Math.min(count, start + VIRTUAL_WINDOW_SIZE);
        return Array.from({ length: Math.max(0, end - start) }, (_, offset) => {
          const index = start + offset;
          return {
            index,
            key: `virtual-item-${index}`,
            start: index * 120,
            size: 120,
          };
        });
      },
      getTotalSize: () => count * 120,
      measureElement: vi.fn(),
      scrollToIndex: (
        index: number,
        options?: { align?: 'start' | 'center' | 'end' | 'auto' },
      ) => {
        scrollToIndexMock(index, options);
        if (count <= 0) {
          virtualWindowStartIndex = 0;
          return;
        }
        const clampedIndex = Math.min(Math.max(0, index), Math.max(0, count - 1));
        if (options?.align === 'end') {
          virtualWindowStartIndex = Math.max(0, clampedIndex - (VIRTUAL_WINDOW_SIZE - 1));
          return;
        }
        virtualWindowStartIndex = clampedIndex;
      },
      getOffsetForIndex: (
        index: number,
      ) => {
        if (index < 0 || index >= count) {
          return undefined;
        }
        return [index * 120, 'start'] as const;
      },
      scrollToOffset: (offset: number) => {
        scrollToOffsetMock(offset);
        if (count <= 0) {
          virtualWindowStartIndex = 0;
          return;
        }
        const targetIndex = Math.floor(Math.max(0, offset) / 120);
        virtualWindowStartIndex = Math.min(Math.max(0, targetIndex), Math.max(0, count - 1));
      },
    };
    queueMicrotask(() => {
      act(() => {
        onChange?.(instance, false);
      });
    });
    return instance;
  },
}));

describe('chat 会话切换 UI 回归', () => {
  let scrollIntoViewMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    i18n.changeLanguage('en');
    trackUiEventMock.mockReset();
    scrollToIndexMock.mockReset();
    scrollToOffsetMock.mockReset();
    virtualWindowStartIndex = 0;
    triggerResizeObserver = null;
    resizeObserverCallbacks = [];
    (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
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
      snapshotReady: true,
      initialLoading: false,
      refreshing: false,
      mutating: false,
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
      sessionRuntimeByKey: {
        'agent:another:main': {
          messages: [
            {
              role: 'assistant',
              content: 'another session latest message',
              timestamp: Date.now() / 1000,
              id: 'another-msg-1',
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
    expect(screen.getByText('another session latest message')).toBeInTheDocument();

    act(() => {
      useChatStore.getState().switchSession('agent:test:main');
    });

    expect(screen.getByText('test pending message')).toBeInTheDocument();
    expect(screen.queryByText('MatchaClaw Chat')).not.toBeInTheDocument();
    expect(useChatStore.getState().sending).toBe(true);
    expect(useChatStore.getState().pendingFinal).toBe(true);
  });

  it('重复切换当前会话时，不应触发额外刷新链路', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <TooltipProvider>
          <Chat />
        </TooltipProvider>
      </MemoryRouter>,
    );

    const loadHistoryMock = useChatStore.getState().loadHistory as ReturnType<typeof vi.fn>;
    await waitFor(() => {
      expect(loadHistoryMock).toHaveBeenCalled();
    });
    loadHistoryMock.mockClear();

    const before = useChatStore.getState();
    const beforeMessagesRef = before.messages;
    const beforeSessionRuntimeRef = before.sessionRuntimeByKey;

    act(() => {
      useChatStore.getState().switchSession('agent:test:main');
    });

    const after = useChatStore.getState();
    expect(loadHistoryMock).not.toHaveBeenCalled();
    expect(after.currentSessionKey).toBe('agent:test:main');
    expect(after.messages).toBe(beforeMessagesRef);
    expect(after.sessionRuntimeByKey).toBe(beforeSessionRuntimeRef);
  });

  it('切换会话时应上报 switch_start 诊断事件', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <TooltipProvider>
          <Chat />
        </TooltipProvider>
      </MemoryRouter>,
    );

    trackUiEventMock.mockClear();

    act(() => {
      useChatStore.getState().switchSession('agent:another:main');
    });

    await waitFor(() => {
      expect(hasTelemetryEvent('chat.session_switch_start', (payload) => (
        payload.fromSessionKey === 'agent:test:main'
        && payload.toSessionKey === 'agent:another:main'
        && payload.hasTargetRuntimeSnapshot === true
        && payload.targetSessionReady === true
      ))).toBe(true);
    });
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

    scrollToIndexMock.mockClear();
    fireEvent.scroll(viewport);

    act(() => {
      useChatStore.getState().switchSession('agent:another:main');
    });

    await waitFor(() => {
      expect(scrollToIndexMock).toHaveBeenCalled();
      expect(scrollToIndexMock.mock.calls.at(-1)).toEqual([0, { align: 'end' }]);
    });
    await waitFor(() => {
      expect(viewport.scrollTop).toBe(1200);
    });
  });

  it('离开会话前已上翻历史，再次点开时应重新吸底并落在最新消息底部', async () => {
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

    fireEvent.wheel(viewport, { deltaY: -240 });
    fireEvent.scroll(viewport);

    scrollToIndexMock.mockClear();

    act(() => {
      useChatStore.getState().switchSession('agent:another:main');
    });

    act(() => {
      useChatStore.getState().switchSession('agent:test:main');
    });

    await waitFor(() => {
      expect(viewport.scrollTop).toBe(1200);
    });
    expect(scrollToIndexMock).toHaveBeenCalled();
    expect(scrollToIndexMock.mock.calls.at(-1)).toEqual([1, { align: 'end' }]);
  });

  it('切换会话时 assistant markdown 不应先退化为纯文本，避免闪烁抖动', async () => {
    useChatStore.setState({
      currentSessionKey: 'agent:test:main',
      sessions: [
        { key: 'agent:test:main', displayName: 'agent:test:main' },
        { key: 'agent:another:main', displayName: 'agent:another:main' },
      ],
      messages: [
        {
          role: 'assistant',
          content: 'plain message',
          timestamp: Date.now() / 1000,
          id: 'plain-message',
        },
      ],
      sessionRuntimeByKey: {
        'agent:another:main': {
          messages: [
            {
              role: 'assistant',
              content: '[OpenAI](https://openai.com)',
              timestamp: Date.now() / 1000,
              id: 'markdown-message',
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
      sending: false,
      activeRunId: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      approvalStatus: 'idle',
      snapshotReady: true,
      sessionReadyByKey: {
        'agent:test:main': true,
        'agent:another:main': true,
      },
    } as never);

    render(
      <MemoryRouter initialEntries={['/']}>
        <TooltipProvider>
          <Chat />
        </TooltipProvider>
      </MemoryRouter>,
    );

    act(() => {
      useChatStore.getState().switchSession('agent:another:main');
    });

    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'OpenAI' })).toBeInTheDocument();
    });
    expect(screen.queryByText('[OpenAI](https://openai.com)')).not.toBeInTheDocument();
  });

  it('sessionRuntimeByKey 超限时应按 LRU 收敛，并保留当前与 sending 会话快照', () => {
    const runtimeByKey: Record<string, {
      messages: Array<{ role: string; content: string; timestamp: number; id: string }>;
      sending: boolean;
      activeRunId: string | null;
      streamingText: string;
      streamingMessage: null;
      streamingTools: [];
      pendingFinal: boolean;
      lastUserMessageAt: null;
      pendingToolImages: [];
      approvalStatus: 'idle';
    }> = {};
    const runtimeSessions = Array.from({ length: 72 }, (_, index) => `agent:test:session-lru-${index}`);
    const sendingKeepKey = runtimeSessions[1];
    const targetKey = runtimeSessions[runtimeSessions.length - 1];

    for (const sessionKey of runtimeSessions) {
      runtimeByKey[sessionKey] = {
        messages: [{
          role: 'assistant',
          content: `runtime-${sessionKey}`,
          timestamp: Date.now() / 1000,
          id: `runtime-${sessionKey}`,
        }],
        sending: sessionKey === sendingKeepKey,
        activeRunId: sessionKey === sendingKeepKey ? 'run-keep' : null,
        streamingText: '',
        streamingMessage: null,
        streamingTools: [],
        pendingFinal: false,
        lastUserMessageAt: null,
        pendingToolImages: [],
        approvalStatus: 'idle',
      };
    }

    useChatStore.setState((state) => ({
      ...state,
      currentSessionKey: 'agent:test:main',
      sessions: [
        { key: 'agent:test:main', displayName: 'agent:test:main' },
        ...runtimeSessions.map((key) => ({ key, displayName: key })),
      ],
      messages: [
        {
          role: 'assistant',
          content: 'main session snapshot',
          timestamp: Date.now() / 1000,
          id: 'main-session-msg',
        },
      ],
      sessionRuntimeByKey: runtimeByKey,
      sessionReadyByKey: {
        'agent:test:main': true,
        [targetKey]: true,
      },
      sending: false,
      activeRunId: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      approvalStatus: 'idle',
    }));

    act(() => {
      useChatStore.getState().switchSession(targetKey);
    });

    const next = useChatStore.getState();
    const runtimeKeys = Object.keys(next.sessionRuntimeByKey);
    expect(next.currentSessionKey).toBe(targetKey);
    expect(runtimeKeys.length).toBeLessThanOrEqual(48);
    expect(next.sessionRuntimeByKey[targetKey]).toBeDefined();
    expect(next.sessionRuntimeByKey['agent:test:main']).toBeDefined();
    expect(next.sessionRuntimeByKey[sendingKeepKey]?.sending).toBe(true);
  });

  it('原本在底部附近时，新消息追加后应继续自动吸底', async () => {
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

    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 320 });
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 320 });
    Object.defineProperty(viewport, 'scrollTop', { configurable: true, writable: true, value: 0 });

    fireEvent.scroll(viewport);
    scrollToIndexMock.mockClear();

    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 640 });

    act(() => {
      useChatStore.setState((state) => ({
        messages: [
          ...state.messages,
          {
            role: 'assistant',
            content: 'new assistant message',
            timestamp: Date.now() / 1000,
            id: 'assistant-msg-2',
          },
        ],
      }));
    });

    await waitFor(() => {
      expect(scrollToIndexMock).toHaveBeenCalled();
      expect(scrollToIndexMock.mock.calls.at(-1)).toEqual([2, { align: 'end' }]);
    });
  });

  it('流式内容增长但行数不变时，仍应持续吸底', async () => {
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

    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 320 });
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 320 });
    Object.defineProperty(viewport, 'scrollTop', { configurable: true, writable: true, value: 0 });

    fireEvent.scroll(viewport);
    await act(async () => {
      await Promise.resolve();
    });

    scrollToIndexMock.mockClear();
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 980 });

    act(() => {
      useChatStore.setState({
        sending: true,
        pendingFinal: false,
        streamingMessage: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'streaming text line 1\nstreaming text line 2\nstreaming text line 3' },
          ],
        },
      } as never);
    });

    triggerResizeObserver?.();
    await act(async () => {
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(viewport.scrollTop).toBe(980);
    });
    expect(scrollToIndexMock).not.toHaveBeenCalled();
  });

  it('顶部触发扩窗时，不应误判为会话切换并自动回到底部', async () => {
    const nowTs = Date.now() / 1000;
    const longMessages = Array.from({ length: 24 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `long-history-message-${index}`,
      timestamp: nowTs + index,
      id: `long-history-${index}`,
    }));
    useChatStore.setState({
      currentSessionKey: 'agent:test:main',
      sessions: [{ key: 'agent:test:main', displayName: 'agent:test:main' }],
      messages: longMessages,
      snapshotReady: true,
      sessionReadyByKey: { 'agent:test:main': true },
      loadSessions: vi.fn().mockResolvedValue(undefined),
      loadHistory: vi.fn().mockResolvedValue(undefined),
    } as never);

    const { container } = render(
      <MemoryRouter initialEntries={['/']}>
        <TooltipProvider>
          <Chat />
        </TooltipProvider>
      </MemoryRouter>,
    );

    // 首屏窗口化后，最早消息不应立刻可见
    expect(screen.queryByText('long-history-message-0')).not.toBeInTheDocument();

    const viewport = container.querySelector('.overflow-y-auto') as HTMLDivElement | null;
    expect(viewport).toBeTruthy();
    if (!viewport) {
      return;
    }

    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 3600 });
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 320 });
    Object.defineProperty(viewport, 'scrollTop', { configurable: true, writable: true, value: 0 });

    scrollToIndexMock.mockClear();
    fireEvent.wheel(viewport, { deltaY: -240 });
    fireEvent.scroll(viewport);
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.wheel(viewport, { deltaY: -180 });
    fireEvent.scroll(viewport);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 220));
    });

    await waitFor(() => {
      const hasAnchorCompensation = scrollToOffsetMock.mock.calls.some((call) => (
        typeof call[0] === 'number' && Number.isFinite(call[0]) && call[0] >= 0
      ));
      expect(hasAnchorCompensation).toBe(true);
    });
    // 关键断言：扩窗后不应被强制拉回底部（align:end）
    const hasForcedBottomScroll = scrollToIndexMock.mock.calls.some((call) => {
      const options = call[1] as { align?: string } | undefined;
      return options?.align === 'end';
    });
    expect(hasForcedBottomScroll).toBe(false);
  });

  it('未进入 detached 时到顶也应触发扩窗，避免卡在首屏窗口上边界', async () => {
    const nowTs = Date.now() / 1000;
    const longMessages = Array.from({ length: 24 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `top-expand-sticky-message-${index}`,
      timestamp: nowTs + index,
      id: `top-expand-sticky-${index}`,
    }));

    useChatStore.setState({
      currentSessionKey: 'agent:test:main',
      sessions: [{ key: 'agent:test:main', displayName: 'agent:test:main' }],
      messages: longMessages,
      snapshotReady: true,
      sessionReadyByKey: { 'agent:test:main': true },
      loadSessions: vi.fn().mockResolvedValue(undefined),
      loadHistory: vi.fn().mockResolvedValue(undefined),
    } as never);

    const { container } = render(
      <MemoryRouter initialEntries={['/']}>
        <TooltipProvider>
          <Chat />
        </TooltipProvider>
      </MemoryRouter>,
    );

    expect(screen.queryByText('top-expand-sticky-message-0')).not.toBeInTheDocument();

    const viewport = container.querySelector('.overflow-y-auto') as HTMLDivElement | null;
    expect(viewport).toBeTruthy();
    if (!viewport) {
      return;
    }

    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 3600 });
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 320 });
    Object.defineProperty(viewport, 'scrollTop', { configurable: true, writable: true, value: 0 });

    fireEvent.wheel(viewport, { deltaY: -220 });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 220));
    });

    await waitFor(() => {
      const expandedAtTop = trackUiEventMock.mock.calls.some((call) => (
        call[0] === 'chat.render_window_budget_advance'
        && (call[1] as { reason?: string } | undefined)?.reason === 'top-headroom'
      ));
      expect(expandedAtTop).toBe(true);
    });
  });

  it('扩窗后离开再进入同会话，首屏窗口应重置为固定预算，避免继承上次扩窗', async () => {
    const nowTs = Date.now() / 1000;
    const longMessages = Array.from({ length: 24 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `long-history-message-${index}`,
      timestamp: nowTs + index,
      id: `long-history-reset-${index}`,
    }));

    useChatStore.setState({
      currentSessionKey: 'agent:test:main',
      sessions: [{ key: 'agent:test:main', displayName: 'agent:test:main' }],
      messages: longMessages,
      snapshotReady: true,
      sessionReadyByKey: { 'agent:test:main': true },
      loadSessions: vi.fn().mockResolvedValue(undefined),
      loadHistory: vi.fn().mockResolvedValue(undefined),
    } as never);

    const firstMount = render(
      <MemoryRouter initialEntries={['/']}>
        <TooltipProvider>
          <Chat />
        </TooltipProvider>
      </MemoryRouter>,
    );

    const firstViewport = firstMount.container.querySelector('.overflow-y-auto') as HTMLDivElement | null;
    expect(firstViewport).toBeTruthy();
    if (!firstViewport) {
      return;
    }

    Object.defineProperty(firstViewport, 'scrollHeight', { configurable: true, value: 3600 });
    Object.defineProperty(firstViewport, 'clientHeight', { configurable: true, value: 320 });
    Object.defineProperty(firstViewport, 'scrollTop', { configurable: true, writable: true, value: 0 });

    scrollToIndexMock.mockClear();
    scrollToOffsetMock.mockClear();
    fireEvent.wheel(firstViewport, { deltaY: -240 });
    fireEvent.scroll(firstViewport);
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.wheel(firstViewport, { deltaY: -180 });
    fireEvent.scroll(firstViewport);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 220));
    });

    await waitFor(() => {
      const hasExpanded = scrollToOffsetMock.mock.calls.some((call) => (
        typeof call[0] === 'number' && Number.isFinite(call[0]) && call[0] >= 0
      ));
      expect(hasExpanded).toBe(true);
    });

    firstMount.unmount();

    scrollToIndexMock.mockClear();
    const secondMount = render(
      <MemoryRouter initialEntries={['/settings']}>
        <TooltipProvider>
          <Chat />
        </TooltipProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('long-history-message-16')).toBeInTheDocument();
    });
    expect(screen.queryByText('long-history-message-15')).not.toBeInTheDocument();

    secondMount.unmount();
  });

  it('窗口放大后如果首屏消息不足以撑出滚动条，应自动补出更早消息', async () => {
    const nowTs = Date.now() / 1000;
    const longMessages = Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `resize-history-message-${index}`,
      timestamp: nowTs + index,
      id: `resize-history-${index}`,
    }));

    useChatStore.setState({
      currentSessionKey: 'agent:test:main',
      sessions: [{ key: 'agent:test:main', displayName: 'agent:test:main' }],
      messages: longMessages,
      snapshotReady: true,
      sessionReadyByKey: { 'agent:test:main': true },
      loadSessions: vi.fn().mockResolvedValue(undefined),
      loadHistory: vi.fn().mockResolvedValue(undefined),
    } as never);

    const { container } = render(
      <MemoryRouter initialEntries={['/']}>
        <TooltipProvider>
          <Chat />
        </TooltipProvider>
      </MemoryRouter>,
    );

    expect(screen.getByText('resize-history-message-11')).toBeInTheDocument();
    expect(screen.queryByText('resize-history-message-3')).not.toBeInTheDocument();

    const viewport = container.querySelector('.overflow-y-auto') as HTMLDivElement | null;
    expect(viewport).toBeTruthy();
    if (!viewport) {
      return;
    }

    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 960 });
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 320 });
    Object.defineProperty(viewport, 'scrollTop', { configurable: true, writable: true, value: 0 });

    fireEvent.scroll(viewport);
    await act(async () => {
      await Promise.resolve();
    });

    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 1800 });
    triggerResizeObserver?.();

    await waitFor(() => {
      expect(screen.getByText('resize-history-message-3')).toBeInTheDocument();
    });
  });

  it('从其他页面通过 session 参数进入未就绪会话时，不应先闪 Welcome 空态', async () => {
    const pendingLoad = new Promise<void>(() => {
      // keep pending on purpose, we only care about the transition frame
    });
    const loadHistoryPending = vi.fn().mockReturnValue(pendingLoad);
    const loadSessions = vi.fn().mockResolvedValue(undefined);
    useChatStore.setState({
      currentSessionKey: 'agent:test:main',
      sessions: [
        { key: 'agent:test:main', displayName: 'agent:test:main' },
        { key: 'agent:fresh:main', displayName: 'agent:fresh:main' },
      ],
      messages: [
        {
          role: 'user',
          content: 'existing message in current session',
          timestamp: Date.now() / 1000,
          id: 'existing-message',
        },
      ],
      snapshotReady: true,
      sessionRuntimeByKey: {},
      loadHistory: loadHistoryPending,
      loadSessions,
    } as never);

    render(
      <MemoryRouter initialEntries={['/?session=agent:fresh:main']}>
        <TooltipProvider>
          <Chat />
        </TooltipProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(useChatStore.getState().currentSessionKey).toBe('agent:fresh:main');
    });

    expect(screen.queryByText('MatchaClaw Chat')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(hasTelemetryEvent('chat.session_blocking_loading_shown', (payload) => (
        payload.sessionKey === 'agent:fresh:main'
      ))).toBe(true);
    });
  });

  it('从其他页面进入全新会话时，应直接显示 Welcome，不阻塞转圈', async () => {
    const pendingLoad = new Promise<void>(() => {
      // keep pending on purpose, we only care about first paint
    });
    const loadHistoryPending = vi.fn().mockReturnValue(pendingLoad);
    const loadSessions = vi.fn().mockResolvedValue(undefined);
    const freshSessionKey = 'agent:test:session-1760000000000';

    useChatStore.setState({
      currentSessionKey: 'agent:test:main',
      sessions: [
        { key: 'agent:test:main', displayName: 'agent:test:main' },
        { key: freshSessionKey, displayName: freshSessionKey },
      ],
      messages: [
        {
          role: 'assistant',
          content: 'existing message in current session',
          timestamp: Date.now() / 1000,
          id: 'existing-message',
        },
      ],
      snapshotReady: true,
      sessionRuntimeByKey: {},
      sessionLastActivity: {
        'agent:test:main': Date.now(),
      },
      loadHistory: loadHistoryPending,
      loadSessions,
    } as never);

    render(
      <MemoryRouter initialEntries={[`/?session=${freshSessionKey}`]}>
        <TooltipProvider>
          <Chat />
        </TooltipProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(useChatStore.getState().currentSessionKey).toBe(freshSessionKey);
    });

    expect(screen.getByText('MatchaClaw Chat')).toBeInTheDocument();
  });

  it('阻塞加载结束时应上报 blocking_loading_duration', async () => {
    const loadHistory = vi.fn().mockResolvedValue(undefined);
    useChatStore.setState({
      currentSessionKey: 'agent:test:main',
      sessions: [
        { key: 'agent:test:main', displayName: 'agent:test:main' },
        { key: 'agent:fresh:main', displayName: 'agent:fresh:main' },
      ],
      messages: [
        {
          role: 'assistant',
          content: 'main session message',
          timestamp: Date.now() / 1000,
          id: 'main-message',
        },
      ],
      snapshotReady: true,
      sessionReadyByKey: {
        'agent:test:main': true,
      },
      sessionRuntimeByKey: {},
      loadHistory,
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);

    render(
      <MemoryRouter initialEntries={['/']}>
        <TooltipProvider>
          <Chat />
        </TooltipProvider>
      </MemoryRouter>,
    );

    act(() => {
      useChatStore.getState().switchSession('agent:fresh:main');
    });
    await waitFor(() => {
      expect(hasTelemetryEvent('chat.session_blocking_loading_shown', (payload) => (
        payload.sessionKey === 'agent:fresh:main'
      ))).toBe(true);
    });

    act(() => {
      useChatStore.getState().switchSession('agent:test:main');
    });

    await waitFor(() => {
      expect(hasTelemetryEvent('chat.session_blocking_loading_duration', (payload) => (
        payload.sessionKey === 'agent:fresh:main'
        && typeof payload.durationMs === 'number'
      ))).toBe(true);
    });
  });

  it('已有新鲜 agent 快照时，进入 Chat 不应重复调用 loadAgents', async () => {
    const loadAgents = vi.fn().mockResolvedValue(undefined);
    const loadSessions = vi.fn().mockResolvedValue(undefined);
    const loadHistory = vi.fn().mockResolvedValue(undefined);

    useSubagentsStore.setState({
      agents: [
        { id: 'test', name: 'Test Agent', workspace: '.', isDefault: false, createdAt: 1, updatedAt: 1 },
      ],
      snapshotReady: true,
      lastLoadedAt: Date.now(),
      loadAgents,
    } as never);

    useChatStore.setState({
      currentSessionKey: 'agent:test:main',
      sessions: [{ key: 'agent:test:main', displayName: 'agent:test:main' }],
      messages: [
        {
          role: 'assistant',
          content: 'hello',
          timestamp: Date.now() / 1000,
          id: 'assistant-hello',
        },
      ],
      snapshotReady: true,
      sessionReadyByKey: { 'agent:test:main': true },
      loadSessions,
      loadHistory,
    } as never);

    render(
      <MemoryRouter initialEntries={['/']}>
        <TooltipProvider>
          <Chat />
        </TooltipProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(loadSessions).toHaveBeenCalledTimes(1);
    });
    expect(loadAgents).not.toHaveBeenCalled();
  });

  it('启动后应先加载当前会话，再静默预热其它未就绪会话', async () => {
    const loadAgents = vi.fn().mockResolvedValue(undefined);
    const loadSessions = vi.fn().mockResolvedValue(undefined);
    const loadHistory = vi.fn().mockResolvedValue(undefined);

    useSubagentsStore.setState({
      agents: [
        { id: 'test', name: 'Test Agent', workspace: '.', isDefault: false, createdAt: 1, updatedAt: 1 },
        { id: 'another', name: 'Another Agent', workspace: '.', isDefault: false, createdAt: 1, updatedAt: 1 },
      ],
      snapshotReady: true,
      lastLoadedAt: Date.now(),
      loadAgents,
    } as never);

    useChatStore.setState({
      currentSessionKey: 'agent:test:main',
      sessions: [
        { key: 'agent:test:main', displayName: 'agent:test:main' },
        { key: 'agent:another:main', displayName: 'agent:another:main' },
      ],
      messages: [
        {
          role: 'assistant',
          content: 'already-hydrated-current-session',
          timestamp: Date.now() / 1000,
          id: 'hydrated-current',
        },
      ],
      snapshotReady: true,
      sessionReadyByKey: {
        'agent:test:main': true,
      },
      sessionRuntimeByKey: {},
      sessionLastActivity: {
        'agent:another:main': Date.now() - 1_000,
      },
      loadSessions,
      loadHistory,
    } as never);

    render(
      <MemoryRouter initialEntries={['/']}>
        <TooltipProvider>
          <Chat />
        </TooltipProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(loadHistory).toHaveBeenCalledWith(expect.objectContaining({
        sessionKey: 'agent:test:main',
        mode: 'quiet',
        scope: 'foreground',
      }));
    });

    await waitFor(() => {
      expect(loadHistory).toHaveBeenCalledWith(expect.objectContaining({
        sessionKey: 'agent:another:main',
        mode: 'quiet',
        scope: 'background',
      }));
    });

    await waitFor(() => {
      expect(hasTelemetryEvent('chat.history_prewarm_plan', (payload) => (
        payload.targetCount === 1
        && Array.isArray(payload.targets)
        && payload.targets.includes('agent:another:main')
      ))).toBe(true);
    });
    await waitFor(() => {
      expect(hasTelemetryEvent('chat.history_prewarm_dispatch', (payload) => (
        payload.sessionKey === 'agent:another:main'
      ))).toBe(true);
    });
    await waitFor(() => {
      expect(hasTelemetryEvent('chat.history_prewarm_done', (payload) => (
        payload.sessionKey === 'agent:another:main'
      ))).toBe(true);
    });
  });
});
