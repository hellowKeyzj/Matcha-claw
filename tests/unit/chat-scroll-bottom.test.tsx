import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Chat from '@/pages/Chat';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useChatStore } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import { useSubagentsStore } from '@/stores/subagents';
import { useTaskCenterStore } from '@/stores/task-center-store';
import { createEmptySessionRecord } from '@/stores/chat/store-state-helpers';
import { buildRenderItemsFromMessages, type RawMessage } from './helpers/timeline-fixtures';
import { createViewportWindowState } from '@/stores/chat/viewport-state';
import { bottomScrollTop, isAtBottom } from '@/pages/Chat/chat-scroll-model';

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

function buildSessionRecord(
  overrides?: Partial<ReturnType<typeof createEmptySessionRecord>> & { messages?: RawMessage[] },
) {
  const base = createEmptySessionRecord();
  const items = overrides?.messages
    ? buildRenderItemsFromMessages('agent:test:main', overrides.messages)
    : (overrides?.items ?? base.items);
  return {
    meta: { ...base.meta, ...overrides?.meta },
    runtime: { ...base.runtime, ...overrides?.runtime },
    items,
    window: overrides?.window ?? base.window,
  };
}

function streamingAssistant(content: string, timestamp: number): RawMessage {
  return {
    id: 'assistant-1',
    role: 'assistant',
    content,
    timestamp,
    streaming: true,
  };
}

function setupCommonStores() {
  const sessionKey = 'agent:test:main';
  const now = Date.now();
  useGatewayStore.setState({
    status: {
      processState: 'running',
      port: 18789,
      gatewayReady: true,
      healthSummary: 'healthy',
      transportState: 'connected',
      portReachable: true,
      diagnostics: { consecutiveHeartbeatMisses: 0, consecutiveRpcFailures: 0 },
      updatedAt: 1,
    },
  } as never);
  useSubagentsStore.setState({
    agents: [
      { id: 'test', name: 'Test Agent', workspace: '.', isDefault: false, createdAt: 1, updatedAt: 1 },
    ],
    loadAgents: vi.fn().mockResolvedValue(undefined),
    updateAgent: vi.fn().mockResolvedValue(undefined),
  } as never);
  useTaskCenterStore.setState({
    tasks: [],
    loading: false,
    initialLoading: false,
    refreshing: false,
    mutating: false,
    initialized: true,
    error: null,
    init: vi.fn().mockResolvedValue(undefined),
    refreshTasks: vi.fn().mockResolvedValue(undefined),
    openTaskSession: vi.fn().mockReturnValue({ switched: false, reason: 'task_not_found' }),
    clearError: vi.fn(),
  } as never);
  useChatStore.setState({
    loadedSessions: {
      [sessionKey]: buildSessionRecord({
        messages: [
          { role: 'user', content: 'hello', timestamp: now / 1000, id: 'user-1' },
          streamingAssistant('first chunk', now / 1000),
        ],
        window: createViewportWindowState({
          totalItemCount: 2,
          windowStartOffset: 0,
          windowEndOffset: 2,
          isAtLatest: true,
        }),
        meta: { historyStatus: 'ready', lastActivityAt: now },
        runtime: {
          activeRunId: 'run-1',
          runPhase: 'streaming',
          activeTurnItemKey: 'assistant-1',
          pendingTurnKey: null,
          pendingTurnLaneKey: null,
          lastUserMessageAt: now,
        },
      }),
    },
    foregroundHistorySessionKey: null,
    mutating: false,
    error: null,
    pendingApprovalsBySession: {},
    currentSessionKey: sessionKey,
    showThinking: true,
    sessionCatalogStatus: {
      status: 'ready',
      error: null,
      hasLoadedOnce: true,
      lastLoadedAt: now,
    },
    loadHistory: vi.fn().mockResolvedValue(undefined),
    loadSessions: vi.fn().mockResolvedValue(undefined),
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
  metrics: { scrollHeight: number; clientHeight: number; scrollTop: number; clientWidth?: number },
) {
  Object.defineProperty(viewport, 'scrollHeight', {
    configurable: true,
    get: () => metrics.scrollHeight,
  });
  Object.defineProperty(viewport, 'clientHeight', {
    configurable: true,
    get: () => metrics.clientHeight,
  });
  Object.defineProperty(viewport, 'clientWidth', {
    configurable: true,
    get: () => metrics.clientWidth ?? 400,
  });
  Object.defineProperty(viewport, 'scrollTop', {
    configurable: true,
    get: () => metrics.scrollTop,
    set: (value: number) => {
      metrics.scrollTop = value;
    },
  });
}

function installViewportRect(
  viewport: HTMLDivElement,
  metrics: { clientHeight: number; clientWidth?: number },
) {
  Object.defineProperty(viewport, 'getBoundingClientRect', {
    configurable: true,
    value: () => DOMRect.fromRect({
      x: 0,
      y: 0,
      width: metrics.clientWidth ?? 400,
      height: metrics.clientHeight,
    }),
  });
}

function installVirtualItemLayout(
  itemElements: HTMLElement[],
  metrics: { scrollTop: number; clientWidth?: number },
  itemHeights: number[],
) {
  let offsetTop = 0;
  itemElements.forEach((element, index) => {
    const itemTop = offsetTop;
    const itemHeight = itemHeights[index] ?? 0;
    offsetTop += itemHeight;
    Object.defineProperty(element, 'getBoundingClientRect', {
      configurable: true,
      value: () => DOMRect.fromRect({
        x: 0,
        y: itemTop - metrics.scrollTop,
        width: metrics.clientWidth ?? 400,
        height: itemHeight,
      }),
    });
  });
}

function queryItems(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-chat-item-key]'));
}

describe('chat 滚动模型 - phase=follow', () => {
  beforeEach(() => {
    resizeObserverCallbacks = [];
    triggerResizeObserver = null;
    (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
    setupCommonStores();
  });

  it('内容增长应贴底', async () => {
    const { container } = renderChat();
    const viewport = container.querySelector('.overflow-y-auto') as HTMLDivElement;
    const metrics = { scrollHeight: 980, clientHeight: 320, scrollTop: 660 };
    installViewportMetrics(viewport, metrics);

    act(() => {
      triggerResizeObserver?.();
    });

    act(() => {
      metrics.scrollHeight = 1300;
      triggerResizeObserver?.();
    });

    await waitFor(() => {
      expect(metrics.scrollTop).toBe(980);
    });
  });

  it('viewport 高度变小时也应继续贴底', async () => {
    useChatStore.setState({
      loadedSessions: {
        'agent:test:main': buildSessionRecord({
          messages: [
            { role: 'user', content: 'older message', timestamp: Date.now() / 1000, id: 'user-1' },
            { role: 'assistant', content: 'assistant body', timestamp: Date.now() / 1000, id: 'assistant-1' },
          ],
          window: createViewportWindowState({
            totalItemCount: 2,
            windowStartOffset: 0,
            windowEndOffset: 2,
            isAtLatest: true,
          }),
          meta: { historyStatus: 'ready', lastActivityAt: Date.now() },
        }),
      },
    } as never);

    const { container } = renderChat();
    const viewport = container.querySelector('.overflow-y-auto') as HTMLDivElement;
    const metrics = { scrollHeight: 980, clientHeight: 320, scrollTop: 0 };
    installViewportMetrics(viewport, metrics);

    act(() => {
      triggerResizeObserver?.();
    });

    await waitFor(() => {
      expect(metrics.scrollTop).toBe(660);
    });

    act(() => {
      metrics.clientHeight = 220;
      triggerResizeObserver?.();
    });

    await waitFor(() => {
      expect(metrics.scrollTop).toBe(760);
    });
  });
});

describe('chat 滚动模型 - 用户上滑后转 detached', () => {
  beforeEach(() => {
    resizeObserverCallbacks = [];
    triggerResizeObserver = null;
    (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
    setupCommonStores();
  });

  it('上滑后流式增长不再抢滚动 (核心回归)', async () => {
    const { container } = renderChat();
    const viewport = container.querySelector('.overflow-y-auto') as HTMLDivElement;
    const metrics = { scrollHeight: 980, clientHeight: 320, scrollTop: 660 };
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
        loadedSessions: {
          'agent:test:main': buildSessionRecord({
            messages: [
              { role: 'user', content: 'hello', timestamp: Date.now() / 1000, id: 'user-1' },
              streamingAssistant('first chunk second chunk', Date.now() / 1000),
            ],
            window: createViewportWindowState({
              totalItemCount: 2,
              windowStartOffset: 0,
              windowEndOffset: 2,
              isAtLatest: true,
            }),
            meta: { historyStatus: 'ready', lastActivityAt: Date.now() },
            runtime: {
              ...useChatStore.getState().loadedSessions['agent:test:main']!.runtime,
              activeTurnItemKey: 'assistant-1',
            },
          }),
        },
      } as never);
      triggerResizeObserver?.();
    });

    await waitFor(() => {
      expect(metrics.scrollTop).toBe(420);
    });
  });

  it('上滑后 jump-to-bottom 按钮立即出现', async () => {
    const { container } = renderChat();
    const viewport = container.querySelector('.overflow-y-auto') as HTMLDivElement;
    const metrics = { scrollHeight: 980, clientHeight: 320, scrollTop: 660 };
    installViewportMetrics(viewport, metrics);

    act(() => {
      triggerResizeObserver?.();
    });

    act(() => {
      fireEvent.wheel(viewport, { deltaY: -120 });
      metrics.scrollTop = 420;
      fireEvent.scroll(viewport);
    });

    expect(await screen.findByRole('button', { name: 'Jump to bottom' })).toBeInTheDocument();
  });

  it('detached 后窗口缩小不会被拉回底部', async () => {
    useChatStore.setState({
      loadedSessions: {
        'agent:test:main': buildSessionRecord({
          messages: [
            { role: 'user', content: 'older message', timestamp: Date.now() / 1000, id: 'user-1' },
            { role: 'assistant', content: 'assistant body', timestamp: Date.now() / 1000, id: 'assistant-1' },
          ],
          window: createViewportWindowState({
            totalItemCount: 2,
            windowStartOffset: 0,
            windowEndOffset: 2,
            isAtLatest: true,
          }),
          meta: { historyStatus: 'ready', lastActivityAt: Date.now() },
        }),
      },
    } as never);

    const { container } = renderChat();
    const viewport = container.querySelector('.overflow-y-auto') as HTMLDivElement;
    const metrics = { scrollHeight: 980, clientHeight: 320, scrollTop: 0 };
    installViewportMetrics(viewport, metrics);

    act(() => {
      triggerResizeObserver?.();
    });

    await waitFor(() => {
      expect(metrics.scrollTop).toBe(660);
    });

    act(() => {
      fireEvent.wheel(viewport, { deltaY: -120 });
      metrics.scrollTop = 420;
      fireEvent.scroll(viewport);
    });

    act(() => {
      metrics.clientHeight = 220;
      triggerResizeObserver?.();
    });

    await waitFor(() => {
      expect(metrics.scrollTop).toBe(420);
    });
  });

  it('用户重新滚到底部后恢复跟随', async () => {
    const { container } = renderChat();
    const viewport = container.querySelector('.overflow-y-auto') as HTMLDivElement;
    const metrics = { scrollHeight: 980, clientHeight: 320, scrollTop: 660 };
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
});

describe('chat 滚动模型 - 显式过渡', () => {
  beforeEach(() => {
    resizeObserverCallbacks = [];
    triggerResizeObserver = null;
    (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
    setupCommonStores();
  });

  it('点 jump-to-bottom 应直接贴底并恢复跟随', async () => {
    const { container } = renderChat();
    const viewport = container.querySelector('.overflow-y-auto') as HTMLDivElement;
    const metrics = { scrollHeight: 980, clientHeight: 320, scrollTop: 660 };
    installViewportMetrics(viewport, metrics);

    act(() => {
      triggerResizeObserver?.();
      fireEvent.wheel(viewport, { deltaY: -120 });
      metrics.scrollTop = 420;
      fireEvent.scroll(viewport);
    });

    const jumpButton = await screen.findByRole('button', { name: 'Jump to bottom' });
    fireEvent.click(jumpButton);

    await waitFor(() => {
      expect(metrics.scrollTop).toBe(660);
    });
  });

  it('非 latest 窗口点击 jump 应先调 jumpViewportToLatest，落地后立即贴底', async () => {
    const jumpViewportToLatest = vi.fn().mockImplementation(async () => {
      useChatStore.setState({
        loadedSessions: {
          'agent:test:main': buildSessionRecord({
            messages: [
              { role: 'user', content: 'older message', timestamp: Date.now() / 1000, id: 'user-1' },
              { role: 'assistant', content: 'latest message', timestamp: Date.now() / 1000, id: 'assistant-1' },
            ],
            window: createViewportWindowState({
              totalItemCount: 2,
              windowStartOffset: 0,
              windowEndOffset: 2,
              hasMore: false,
              hasNewer: false,
              isAtLatest: true,
            }),
            meta: { historyStatus: 'ready', lastActivityAt: Date.now() },
          }),
        },
      } as never);
    });
    useChatStore.setState({
      loadedSessions: {
        'agent:test:main': buildSessionRecord({
          messages: [
            { role: 'user', content: 'older message', timestamp: Date.now() / 1000, id: 'user-1' },
            { role: 'assistant', content: 'latest message', timestamp: Date.now() / 1000, id: 'assistant-1' },
          ],
          window: createViewportWindowState({
            totalItemCount: 2,
            windowStartOffset: 0,
            windowEndOffset: 1,
            hasMore: false,
            hasNewer: true,
            isAtLatest: false,
          }),
          meta: { historyStatus: 'ready', lastActivityAt: Date.now() },
        }),
      },
      jumpViewportToLatest,
    } as never);

    const { container } = renderChat();
    const viewport = container.querySelector('.overflow-y-auto') as HTMLDivElement;
    const metrics = { scrollHeight: 980, clientHeight: 320, scrollTop: 420 };
    installViewportMetrics(viewport, metrics);

    act(() => {
      triggerResizeObserver?.();
      fireEvent.wheel(viewport, { deltaY: -120 });
      metrics.scrollTop = 420;
      fireEvent.scroll(viewport);
    });

    const jumpButton = await screen.findByRole('button', { name: 'Jump to bottom' });
    fireEvent.click(jumpButton);

    expect(jumpViewportToLatest).toHaveBeenCalledWith('agent:test:main');
    await waitFor(() => {
      expect(metrics.scrollTop).toBe(660);
    });
  });

  it('加载更早消息后保持当前阅读锚点', async () => {
    const loadOlderViewportItems = vi.fn().mockResolvedValue(undefined);
    useChatStore.setState({
      loadedSessions: {
        'agent:test:main': buildSessionRecord({
          messages: [
            { role: 'user', content: 'message-0', timestamp: 0, id: 'user-0' },
            { role: 'assistant', content: 'message-0.5', timestamp: 0.5, id: 'assistant-0' },
            { role: 'user', content: 'message-1', timestamp: 1, id: 'user-1' },
            { role: 'assistant', content: 'message-2', timestamp: 2, id: 'assistant-1' },
          ],
          window: createViewportWindowState({
            totalItemCount: 4,
            windowStartOffset: 2,
            windowEndOffset: 4,
            hasMore: true,
            isAtLatest: true,
          }),
          meta: { historyStatus: 'ready', lastActivityAt: Date.now() },
        }),
      },
      loadOlderViewportItems,
    } as never);

    const { container } = renderChat();
    const viewport = container.querySelector('.overflow-y-auto') as HTMLDivElement;
    const metrics = { scrollHeight: 300, clientHeight: 100, clientWidth: 400, scrollTop: 200 };
    installViewportMetrics(viewport, metrics);
    installViewportRect(viewport, metrics);
    let itemElements = queryItems(container);
    installVirtualItemLayout(itemElements, metrics, [80, 120]);

    await waitFor(() => {
      expect(metrics.scrollTop).toBe(200);
    });

    act(() => {
      fireEvent.wheel(viewport, { deltaY: -120 });
      metrics.scrollTop = 60;
      fireEvent.scroll(viewport);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Load older messages' }));
    expect(loadOlderViewportItems).toHaveBeenCalledWith('agent:test:main');

    act(() => {
      metrics.scrollHeight = 370;
      useChatStore.setState({
        loadedSessions: {
          'agent:test:main': buildSessionRecord({
            messages: [
              { role: 'user', content: 'message-0', timestamp: 0, id: 'user-0' },
              { role: 'assistant', content: 'message-0.5', timestamp: 0.5, id: 'assistant-0' },
              { role: 'user', content: 'older message', timestamp: 0.75, id: 'user-older' },
              { role: 'user', content: 'message-1', timestamp: 1, id: 'user-1' },
              { role: 'assistant', content: 'message-2', timestamp: 2, id: 'assistant-1' },
            ],
            window: createViewportWindowState({
              totalItemCount: 5,
              windowStartOffset: 2,
              windowEndOffset: 5,
              hasMore: true,
              isAtLatest: true,
            }),
            meta: { historyStatus: 'ready', lastActivityAt: Date.now() },
          }),
        },
      } as never);
    });

    itemElements = queryItems(container);
    installVirtualItemLayout(itemElements, metrics, [70, 80, 120]);

    await waitFor(() => {
      expect(metrics.scrollTop).toBe(130);
    });
  });
});

describe('chat 滚动模型 - 输入框浮层滚轮代理', () => {
  beforeEach(() => {
    resizeObserverCallbacks = [];
    triggerResizeObserver = null;
    (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
    setupCommonStores();
  });

  it('停在浮层时滚轮下滚仍能滚动列表', async () => {
    const { container } = renderChat();
    const viewport = container.querySelector('.chat-scroll-sync-viewport') as HTMLDivElement;
    const composerInput = container.querySelector('.chat-scroll-sync-input') as HTMLDivElement;
    const metrics = { scrollHeight: 1200, clientHeight: 320, scrollTop: 500 };
    installViewportMetrics(viewport, metrics);

    act(() => {
      fireEvent.wheel(composerInput, { deltaY: 160 });
    });

    expect(metrics.scrollTop).toBe(660);
  });

  it('浮层上滑后转 detached，后续内容增长不被拉回底部', async () => {
    const { container } = renderChat();
    const viewport = container.querySelector('.chat-scroll-sync-viewport') as HTMLDivElement;
    const composerInput = container.querySelector('.chat-scroll-sync-input') as HTMLDivElement;
    const itemElements = queryItems(container);
    const metrics = { scrollHeight: 1200, clientHeight: 320, scrollTop: 880 };
    installViewportMetrics(viewport, metrics);
    installViewportRect(viewport, metrics);
    installVirtualItemLayout(itemElements, metrics, [160, 220]);

    act(() => {
      triggerResizeObserver?.();
    });

    act(() => {
      fireEvent.wheel(composerInput, { deltaY: -160 });
    });

    expect(metrics.scrollTop).toBe(720);

    act(() => {
      metrics.scrollHeight = 1440;
      triggerResizeObserver?.();
    });

    expect(metrics.scrollTop).toBe(720);
  });

  it('输入框 textarea 自己还能滚时不抢它', async () => {
    const { container } = renderChat();
    const viewport = container.querySelector('.chat-scroll-sync-viewport') as HTMLDivElement;
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    const metrics = { scrollHeight: 1200, clientHeight: 320, scrollTop: 500 };
    installViewportMetrics(viewport, metrics);
    Object.defineProperty(textarea, 'scrollHeight', { configurable: true, get: () => 400 });
    Object.defineProperty(textarea, 'clientHeight', { configurable: true, get: () => 80 });
    Object.defineProperty(textarea, 'scrollTop', { configurable: true, get: () => 40 });

    act(() => {
      fireEvent.wheel(textarea, { deltaY: 160 });
    });

    expect(metrics.scrollTop).toBe(500);
  });
});

describe('chat 滚动模型 - 几何工具', () => {
  it('isAtBottom 仅吸收亚像素抖动，不被 96px 阈值污染', () => {
    expect(isAtBottom({ scrollHeight: 1000, clientHeight: 300, scrollTop: 700, clientWidth: 800 })).toBe(true);
    expect(isAtBottom({ scrollHeight: 1000, clientHeight: 300, scrollTop: 699, clientWidth: 800 })).toBe(false);
    expect(isAtBottom({ scrollHeight: 1000, clientHeight: 300, scrollTop: 700.5, clientWidth: 800 })).toBe(true);
  });

  it('bottomScrollTop 给出贴底位置', () => {
    expect(bottomScrollTop({ scrollHeight: 1180, clientHeight: 320, scrollTop: 0, clientWidth: 800 })).toBe(860);
    expect(bottomScrollTop({ scrollHeight: 200, clientHeight: 300, scrollTop: 0, clientWidth: 800 })).toBe(0);
  });
});
