import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Chat from '@/pages/Chat';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useChatStore } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import { useSubagentsStore } from '@/stores/subagents';
import { useTaskInboxStore } from '@/stores/task-inbox-store';
import { computeBottomLockedScrollTopOnResize, isChatViewportNearBottom } from '@/pages/Chat/useChatScroll';

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

function setupCommonStores() {
  const loadHistory = vi.fn().mockResolvedValue(undefined);
  const loadSessions = vi.fn().mockResolvedValue(undefined);

  useGatewayStore.setState({
    status: { state: 'running', port: 18789 },
  } as never);

  useSubagentsStore.setState({
    agents: [
      { id: 'test', name: 'Test Agent', workspace: '.', isDefault: false, createdAt: 1, updatedAt: 1 },
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
    messages: [
      {
        role: 'user',
        content: 'hello',
        timestamp: Date.now() / 1000,
        id: 'user-1',
      },
    ],
    snapshotReady: true,
    initialLoading: false,
    refreshing: false,
    mutating: false,
    error: null,
    sending: true,
    activeRunId: 'run-1',
    runPhase: 'streaming',
    streamingMessage: {
      id: 'assistant-1',
      role: 'assistant',
      content: 'first chunk',
      timestamp: Date.now() / 1000,
    },
    streamRuntime: {
      sessionKey: 'agent:test:main',
      runId: 'run-1',
      chunks: ['first chunk'],
      rawChars: 'first chunk'.length,
      displayedChars: 'first chunk'.length,
      status: 'streaming',
      rafId: null,
    },
    streamingTools: [],
    pendingFinal: false,
    lastUserMessageAt: Date.now(),
    pendingToolImages: [],
    approvalStatus: 'idle',
    pendingApprovalsBySession: {},
    sessions: [{ key: 'agent:test:main', displayName: 'agent:test:main' }],
    currentSessionKey: 'agent:test:main',
    sessionLabels: {},
    sessionLastActivity: { 'agent:test:main': Date.now() },
    sessionReadyByKey: { 'agent:test:main': true },
    sessionRuntimeByKey: {},
    showThinking: true,
    thinkingLevel: null,
    loadHistory,
    loadSessions,
  } as never);
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

describe('chat 主线程滚动锁', () => {
  beforeEach(() => {
    resizeObserverCallbacks = [];
    triggerResizeObserver = null;
    (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
    setupCommonStores();
  });

  it('锁底时流式增长应持续贴底', async () => {
    const { container } = renderChat();
    const viewport = container.querySelector('.overflow-y-auto') as HTMLDivElement;
    const metrics = {
      scrollHeight: 980,
      clientHeight: 320,
      scrollTop: 660,
    };
    installViewportMetrics(viewport, metrics);

    act(() => {
      triggerResizeObserver?.();
    });

    act(() => {
      metrics.scrollHeight = 1300;
      useChatStore.setState({
        streamingMessage: {
          id: 'assistant-1',
          role: 'assistant',
          content: 'first chunk second chunk',
          timestamp: Date.now() / 1000,
        },
      } as never);
      triggerResizeObserver?.();
    });

    await waitFor(() => {
      expect(metrics.scrollTop).toBe(980);
    });
  });

  it('首次启动主会话在历史内容落地后应自动贴到底部', async () => {
    useChatStore.setState({
      messages: [],
      snapshotReady: false,
      initialLoading: true,
      sending: false,
      activeRunId: null,
      runPhase: 'idle',
      streamingMessage: null,
      streamRuntime: null,
      pendingFinal: false,
      currentSessionKey: 'agent:test:main',
      sessionReadyByKey: { 'agent:test:main': false },
    } as never);

    const { container } = renderChat();
    const viewport = container.querySelector('.overflow-y-auto') as HTMLDivElement;
    const metrics = {
      scrollHeight: 980,
      clientHeight: 320,
      scrollTop: 0,
    };
    installViewportMetrics(viewport, metrics);

    act(() => {
      useChatStore.setState({
        messages: [
          {
            role: 'user',
            content: 'older message',
            timestamp: Date.now() / 1000,
            id: 'user-1',
          },
          {
            role: 'assistant',
            content: 'latest message',
            timestamp: Date.now() / 1000,
            id: 'assistant-1',
          },
        ],
        snapshotReady: true,
        initialLoading: false,
        sessionReadyByKey: { 'agent:test:main': true },
      } as never);
    });

    await waitFor(() => {
      expect(metrics.scrollTop).toBe(660);
    });
  });

  it('用户向上滚后应立即脱离锁底，后续增长不能再抢滚动', async () => {
    const { container } = renderChat();
    const viewport = container.querySelector('.overflow-y-auto') as HTMLDivElement;
    const metrics = {
      scrollHeight: 980,
      clientHeight: 320,
      scrollTop: 660,
    };
    installViewportMetrics(viewport, metrics);

    act(() => {
      triggerResizeObserver?.();
    });

    act(() => {
      fireEvent.wheel(viewport, { deltaY: -120 });
      metrics.scrollTop = 420;
      fireEvent.scroll(viewport);
    });

    act(() => {
      metrics.scrollHeight = 1320;
      useChatStore.setState({
        streamingMessage: {
          id: 'assistant-1',
          role: 'assistant',
          content: 'first chunk second chunk',
          timestamp: Date.now() / 1000,
        },
      } as never);
      triggerResizeObserver?.();
    });

    await waitFor(() => {
      expect(metrics.scrollTop).toBe(420);
    });
  });

  it('用户重新滚到底部后应恢复跟随，后续增长继续贴底', async () => {
    const { container } = renderChat();
    const viewport = container.querySelector('.overflow-y-auto') as HTMLDivElement;
    const metrics = {
      scrollHeight: 980,
      clientHeight: 320,
      scrollTop: 660,
    };
    installViewportMetrics(viewport, metrics);

    act(() => {
      triggerResizeObserver?.();
    });

    act(() => {
      fireEvent.wheel(viewport, { deltaY: -120 });
      metrics.scrollTop = 420;
      fireEvent.scroll(viewport);
    });

    act(() => {
      fireEvent.wheel(viewport, { deltaY: 180 });
      metrics.scrollTop = 660;
      fireEvent.scroll(viewport);
    });

    act(() => {
      metrics.scrollHeight = 1320;
      triggerResizeObserver?.();
    });

    await waitFor(() => {
      expect(metrics.scrollTop).toBe(1000);
    });
  });

  it('正文延迟升级导致高度继续增长时，following 仍能贴底', async () => {
    useChatStore.setState({
      sending: false,
      activeRunId: null,
      runPhase: 'idle',
      streamingMessage: null,
      streamRuntime: null,
      pendingFinal: false,
      messages: [
        {
          role: 'user',
          content: 'older message',
          timestamp: Date.now() / 1000,
          id: 'user-1',
        },
        {
          role: 'assistant',
          content: 'assistant body',
          timestamp: Date.now() / 1000,
          id: 'assistant-1',
        },
      ],
    } as never);

    const { container } = renderChat();
    const viewport = container.querySelector('.overflow-y-auto') as HTMLDivElement;
    const metrics = {
      scrollHeight: 980,
      clientHeight: 320,
      scrollTop: 0,
    };
    installViewportMetrics(viewport, metrics);

    await waitFor(() => {
      expect(metrics.scrollTop).toBe(660);
    });

    act(() => {
      metrics.scrollHeight = 1280;
      triggerResizeObserver?.();
    });

    await waitFor(() => {
      expect(metrics.scrollTop).toBe(960);
    });
  });

  it('helper 只按真实布局量判断近底和目标滚动位', () => {
    expect(isChatViewportNearBottom({
      scrollHeight: 1000,
      clientHeight: 300,
      scrollTop: 690,
    }, 12)).toBe(true);

    expect(isChatViewportNearBottom({
      scrollHeight: 1000,
      clientHeight: 300,
      scrollTop: 650,
    }, 12)).toBe(false);

    expect(computeBottomLockedScrollTopOnResize(
      { scrollHeight: 900, clientHeight: 300, scrollTop: 600 },
      { scrollHeight: 1180, clientHeight: 320, scrollTop: 0 },
    )).toBe(860);
  });
});
