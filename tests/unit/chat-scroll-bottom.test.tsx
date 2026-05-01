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
import { createViewportWindowState } from '@/stores/chat/viewport-state';
import { computeBottomLockedScrollTopOnResize, isChatViewportNearBottom } from '@/pages/Chat/useChatScroll';
import type { RawMessage } from '@/stores/chat';

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

function buildSessionRecord(overrides?: Partial<ReturnType<typeof createEmptySessionRecord>>) {
  const base = createEmptySessionRecord();
  return {
    meta: {
      ...base.meta,
      ...overrides?.meta,
    },
    runtime: {
      ...base.runtime,
      ...overrides?.runtime,
    },
    messages: overrides?.messages ?? base.messages,
    window: overrides?.window ?? base.window,
  };
}

function createStreamingAssistantMessage(content: string, timestamp: number): RawMessage {
  return {
    id: 'assistant-1',
    role: 'assistant',
    content,
    timestamp,
    streaming: true,
  };
}

function setupCommonStores() {
  const loadHistory = vi.fn().mockResolvedValue(undefined);
  const loadSessions = vi.fn().mockResolvedValue(undefined);
  const sessionKey = 'agent:test:main';
  const now = Date.now();

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
    loadedSessions: {
      [sessionKey]: buildSessionRecord({
        messages: [
          {
            role: 'user',
            content: 'hello',
            timestamp: now / 1000,
            id: 'user-1',
          },
          {
            ...createStreamingAssistantMessage('first chunk', now / 1000),
          },
        ],
        window: createViewportWindowState({
          totalMessageCount: 2,
          windowStartOffset: 0,
          windowEndOffset: 2,
          isAtLatest: true,
        }),
        meta: {
          historyStatus: 'ready',
          lastActivityAt: now,
        },
        runtime: {
          sending: true,
          activeRunId: 'run-1',
          runPhase: 'streaming',
          streamingMessageId: 'assistant-1',
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

function installRowHeight(element: HTMLElement, height: number) {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => DOMRect.fromRect({
      x: 0,
      y: 0,
      width: 400,
      height,
    }),
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

function installVirtualRowLayout(
  rowElements: HTMLElement[],
  metrics: { scrollTop: number; clientWidth?: number },
  rowHeights: number[],
) {
  let offsetTop = 0;
  rowElements.forEach((element, index) => {
    const rowTop = offsetTop;
    const rowHeight = rowHeights[index] ?? 0;
    offsetTop += rowHeight;
    Object.defineProperty(element, 'getBoundingClientRect', {
      configurable: true,
      value: () => DOMRect.fromRect({
        x: 0,
        y: rowTop - metrics.scrollTop,
        width: metrics.clientWidth ?? 400,
        height: rowHeight,
      }),
    });
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
    const rowElements = Array.from(container.querySelectorAll<HTMLElement>('[data-chat-row-key][data-chat-row-kind="message"]'));
    const metrics = {
      scrollHeight: 980,
      clientHeight: 320,
      scrollTop: 660,
    };
    installViewportMetrics(viewport, metrics);
    installRowHeight(rowElements[0]!, 120);
    installRowHeight(rowElements[1]!, 80);

    act(() => {
      triggerResizeObserver?.();
    });

    act(() => {
      metrics.scrollHeight = 1300;
      useChatStore.setState({
        loadedSessions: {
          'agent:test:main': {
            ...useChatStore.getState().loadedSessions['agent:test:main'],
            messages: [
              useChatStore.getState().loadedSessions['agent:test:main']!.messages[0]!,
              createStreamingAssistantMessage('first chunk second chunk', Date.now() / 1000),
            ],
            window: createViewportWindowState({
              ...useChatStore.getState().loadedSessions['agent:test:main']!.window,
              totalMessageCount: 2,
              windowStartOffset: 0,
              windowEndOffset: 2,
              isAtLatest: true,
            }),
            runtime: {
              ...useChatStore.getState().loadedSessions['agent:test:main']!.runtime,
              streamingMessageId: 'assistant-1',
            },
          },
        },
      } as never);
      const nextRowElements = Array.from(container.querySelectorAll<HTMLElement>('[data-chat-row-key][data-chat-row-kind="message"]'));
      installRowHeight(nextRowElements[0]!, 120);
      installRowHeight(nextRowElements[1]!, 140);
      triggerResizeObserver?.();
    });

    await waitFor(() => {
      expect(metrics.scrollTop).toBe(980);
    });
  });

  it('发送中旧消息高度变化时，不应因为非尾部 resize 抢滚动', async () => {
    useChatStore.setState({
      loadedSessions: {
        'agent:test:main': buildSessionRecord({
          messages: [
            {
              role: 'user',
              content: 'older message',
              timestamp: Date.now() / 1000,
              id: 'user-1',
            },
            {
              role: 'assistant',
              content: 'tail message',
              timestamp: Date.now() / 1000,
              id: 'assistant-1',
            },
          ],
          window: createViewportWindowState({
            totalMessageCount: 2,
            windowStartOffset: 0,
            windowEndOffset: 2,
            isAtLatest: true,
          }),
          meta: {
            historyStatus: 'ready',
            lastActivityAt: Date.now(),
          },
          runtime: {
            sending: true,
            activeRunId: 'run-1',
            runPhase: 'streaming',
            streamingMessageId: null,
            lastUserMessageAt: Date.now(),
          },
        }),
      },
    } as never);

    const { container } = renderChat();
    const viewport = container.querySelector('.overflow-y-auto') as HTMLDivElement;
    const metrics = {
      scrollHeight: 980,
      clientHeight: 320,
      scrollTop: 660,
    };
    installViewportMetrics(viewport, metrics);
    const initialRows = Array.from(container.querySelectorAll<HTMLElement>('[data-chat-row-key][data-chat-row-kind="message"]'));
    installRowHeight(initialRows[0]!, 120);
    installRowHeight(initialRows[1]!, 80);

    act(() => {
      triggerResizeObserver?.();
    });

    act(() => {
      metrics.scrollHeight = 1180;
      const nextRows = Array.from(container.querySelectorAll<HTMLElement>('[data-chat-row-key][data-chat-row-kind="message"]'));
      installRowHeight(nextRows[0]!, 220);
      installRowHeight(nextRows[1]!, 80);
      triggerResizeObserver?.();
    });

    await waitFor(() => {
      expect(metrics.scrollTop).toBe(660);
    });
  });

  it('锁底时发送中的本地 user message 追加后应立即贴底', async () => {
    useChatStore.setState({
      loadedSessions: {
        'agent:test:main': {
          ...useChatStore.getState().loadedSessions['agent:test:main'],
          messages: [
            {
              role: 'user',
              content: 'hello',
              timestamp: Date.now() / 1000,
              id: 'user-1',
            },
          ],
          window: createViewportWindowState({
            totalMessageCount: 1,
            windowStartOffset: 0,
            windowEndOffset: 1,
            isAtLatest: true,
          }),
          runtime: {
            ...useChatStore.getState().loadedSessions['agent:test:main']!.runtime,
            sending: true,
            streamingMessageId: null,
            pendingFinal: false,
          },
        },
      },
    } as never);

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
      metrics.scrollHeight = 1180;
      useChatStore.setState({
        loadedSessions: {
          'agent:test:main': {
            ...useChatStore.getState().loadedSessions['agent:test:main'],
            messages: [
              ...useChatStore.getState().loadedSessions['agent:test:main']!.messages,
              {
                id: 'pending-user-2',
                role: 'user',
                content: 'pending send',
                timestamp: Date.now() / 1000,
                status: 'sending',
              },
            ],
            window: createViewportWindowState({
              ...useChatStore.getState().loadedSessions['agent:test:main']!.window,
              totalMessageCount: 2,
              windowStartOffset: 0,
              windowEndOffset: 2,
              isAtLatest: true,
            }),
          },
        },
      } as never);
      triggerResizeObserver?.();
    });

    await waitFor(() => {
      expect(metrics.scrollTop).toBe(860);
    });
  });

  it('首次启动主会话在历史内容落地后应自动贴到底部', async () => {
    useChatStore.setState({
      loadedSessions: {
        'agent:test:main': buildSessionRecord(),
      },
      foregroundHistorySessionKey: 'agent:test:main',
      currentSessionKey: 'agent:test:main',
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
        loadedSessions: {
          'agent:test:main': buildSessionRecord({
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
            window: createViewportWindowState({
              totalMessageCount: 2,
              windowStartOffset: 0,
              windowEndOffset: 2,
              isAtLatest: true,
            }),
            meta: {
              historyStatus: 'ready',
              lastActivityAt: Date.now(),
            },
            runtime: useChatStore.getState().loadedSessions['agent:test:main']!.runtime,
          }),
        },
        foregroundHistorySessionKey: null,
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
        loadedSessions: {
          'agent:test:main': {
            ...useChatStore.getState().loadedSessions['agent:test:main'],
            messages: [
              useChatStore.getState().loadedSessions['agent:test:main']!.messages[0]!,
              createStreamingAssistantMessage('first chunk second chunk', Date.now() / 1000),
            ],
            window: createViewportWindowState({
              ...useChatStore.getState().loadedSessions['agent:test:main']!.window,
              totalMessageCount: 2,
              windowStartOffset: 0,
              windowEndOffset: 2,
              isAtLatest: true,
            }),
            runtime: {
              ...useChatStore.getState().loadedSessions['agent:test:main']!.runtime,
              streamingMessageId: 'assistant-1',
            },
          },
        },
      } as never);
      triggerResizeObserver?.();
    });

    await waitFor(() => {
      expect(metrics.scrollTop).toBe(420);
    });
  });

  it('连续上滑查看旧消息时，不应在 wheel/scroll 热路径里同步反复采样阅读锚点', async () => {
    useChatStore.setState({
      loadedSessions: {
        'agent:test:main': buildSessionRecord({
          messages: [
            {
              role: 'user',
              content: 'message-1',
              timestamp: 1,
              id: 'user-1',
            },
            {
              role: 'assistant',
              content: 'message-2',
              timestamp: 2,
              id: 'assistant-1',
            },
            {
              role: 'assistant',
              content: 'message-3',
              timestamp: 3,
              id: 'assistant-2',
            },
          ],
          window: createViewportWindowState({
            totalMessageCount: 3,
            windowStartOffset: 0,
            windowEndOffset: 3,
            isAtLatest: true,
          }),
          meta: {
            historyStatus: 'ready',
            lastActivityAt: Date.now(),
          },
        }),
      },
    } as never);

    const { container } = renderChat();
    const viewport = container.querySelector('.overflow-y-auto') as HTMLDivElement;
    const metrics = {
      scrollHeight: 300,
      clientHeight: 100,
      clientWidth: 400,
      scrollTop: 200,
    };
    installViewportMetrics(viewport, metrics);
    installViewportRect(viewport, metrics);

    const rowElements = Array.from(container.querySelectorAll<HTMLElement>('[data-chat-row-key][data-chat-row-kind="message"]'));
    let anchorRowReadCount = 0;
    let offsetTop = 0;
    for (const [index, element] of rowElements.entries()) {
      const rowTop = offsetTop;
      const rowHeight = [80, 120, 100][index] ?? 80;
      offsetTop += rowHeight;
      Object.defineProperty(element, 'getBoundingClientRect', {
        configurable: true,
        value: () => {
          if (index === 1) {
            anchorRowReadCount += 1;
          }
          return DOMRect.fromRect({
            x: 0,
            y: rowTop - metrics.scrollTop,
            width: metrics.clientWidth,
            height: rowHeight,
          });
        },
      });
    }

    await waitFor(() => {
      expect(metrics.scrollTop).toBe(200);
    });

    anchorRowReadCount = 0;
    act(() => {
      fireEvent.wheel(viewport, { deltaY: -120 });
      metrics.scrollTop = 170;
      fireEvent.scroll(viewport);
      fireEvent.wheel(viewport, { deltaY: -120 });
      metrics.scrollTop = 130;
      fireEvent.scroll(viewport);
      fireEvent.wheel(viewport, { deltaY: -120 });
      metrics.scrollTop = 90;
      fireEvent.scroll(viewport);
    });

    expect(anchorRowReadCount).toBeLessThanOrEqual(1);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
    });

    expect(anchorRowReadCount).toBeGreaterThan(0);
  });

  it('滚动控制器不再依赖 MutationObserver follow pulse', async () => {
    const { container } = renderChat();
    const viewport = container.querySelector('.overflow-y-auto') as HTMLDivElement;
    const metrics = {
      scrollHeight: 980,
      clientHeight: 320,
      scrollTop: 660,
    };
    installViewportMetrics(viewport, metrics);

    await waitFor(() => {
      expect(resizeObserverCallbacks.length).toBeGreaterThan(0);
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

    await waitFor(() => {
      expect(resizeObserverCallbacks.length).toBeGreaterThan(0);
    });
  });

  it('用户重新滚到底部后应恢复跟随，后续增长继续贴底', async () => {
    const { container } = renderChat();
    const viewport = container.querySelector('.overflow-y-auto') as HTMLDivElement;
    const rowElements = Array.from(container.querySelectorAll<HTMLElement>('[data-chat-row-key][data-chat-row-kind="message"]'));
    const metrics = {
      scrollHeight: 980,
      clientHeight: 320,
      scrollTop: 660,
    };
    installViewportMetrics(viewport, metrics);
    installRowHeight(rowElements[0]!, 120);
    installRowHeight(rowElements[1]!, 80);

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
      useChatStore.setState({
        loadedSessions: {
          'agent:test:main': {
            ...useChatStore.getState().loadedSessions['agent:test:main'],
            messages: [
              useChatStore.getState().loadedSessions['agent:test:main']!.messages[0]!,
              createStreamingAssistantMessage('first chunk second chunk', Date.now() / 1000),
            ],
            window: createViewportWindowState({
              ...useChatStore.getState().loadedSessions['agent:test:main']!.window,
              totalMessageCount: 2,
              windowStartOffset: 0,
              windowEndOffset: 2,
              isAtLatest: true,
            }),
            runtime: {
              ...useChatStore.getState().loadedSessions['agent:test:main']!.runtime,
              streamingMessageId: 'assistant-1',
            },
          },
        },
      } as never);
      const nextRowElements = Array.from(container.querySelectorAll<HTMLElement>('[data-chat-row-key][data-chat-row-kind="message"]'));
      installRowHeight(nextRowElements[0]!, 120);
      installRowHeight(nextRowElements[1]!, 140);
      triggerResizeObserver?.();
    });

    await waitFor(() => {
      expect(metrics.scrollTop).toBe(1000);
    });
  });

  it('用户上滑脱离贴底后，点击按钮应立即跳到底部并恢复跟随', async () => {
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

    const jumpButton = await screen.findByRole('button', { name: 'Jump to bottom' });
    fireEvent.click(jumpButton);

    await waitFor(() => {
      expect(metrics.scrollTop).toBe(660);
    });

    act(() => {
      metrics.scrollHeight = 1320;
      useChatStore.setState({
        loadedSessions: {
          'agent:test:main': {
            ...useChatStore.getState().loadedSessions['agent:test:main'],
            messages: [
              useChatStore.getState().loadedSessions['agent:test:main']!.messages[0]!,
              createStreamingAssistantMessage('first chunk second chunk', Date.now() / 1000),
            ],
            window: createViewportWindowState({
              ...useChatStore.getState().loadedSessions['agent:test:main']!.window,
              totalMessageCount: 2,
              windowStartOffset: 0,
              windowEndOffset: 2,
              isAtLatest: true,
            }),
            runtime: {
              ...useChatStore.getState().loadedSessions['agent:test:main']!.runtime,
              streamingMessageId: 'assistant-1',
            },
          },
        },
      } as never);
      triggerResizeObserver?.();
    });

    await waitFor(() => {
      expect(metrics.scrollTop).toBe(1000);
    });
  });

  it('非 latest 窗口首次点击回到底部时，不应先停在旧位置再等下一帧贴底', async () => {
    const jumpToLatest = vi.fn().mockImplementation(async () => {
      useChatStore.setState({
        loadedSessions: {
          'agent:test:main': buildSessionRecord({
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
            window: createViewportWindowState({
              totalMessageCount: 2,
              windowStartOffset: 0,
              windowEndOffset: 2,
              hasMore: false,
              hasNewer: false,
              isAtLatest: true,
            }),
            meta: {
              historyStatus: 'ready',
              lastActivityAt: Date.now(),
            },
          }),
        },
      } as never);
    });
    useChatStore.setState({
      loadedSessions: {
        'agent:test:main': buildSessionRecord({
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
          window: createViewportWindowState({
            totalMessageCount: 2,
            windowStartOffset: 0,
            windowEndOffset: 1,
            hasMore: false,
            hasNewer: true,
            isAtLatest: false,
          }),
          meta: {
            historyStatus: 'ready',
            lastActivityAt: Date.now(),
          },
        }),
      },
      jumpToLatest,
    } as never);

    const rafQueue: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      rafQueue.push(callback);
      return rafQueue.length;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    try {
      const { container } = renderChat();
      const viewport = container.querySelector('.overflow-y-auto') as HTMLDivElement;
      const metrics = {
        scrollHeight: 980,
        clientHeight: 320,
        scrollTop: 420,
      };
      installViewportMetrics(viewport, metrics);

      act(() => {
        triggerResizeObserver?.();
        fireEvent.wheel(viewport, { deltaY: -120 });
        metrics.scrollTop = 420;
        fireEvent.scroll(viewport);
      });

      const jumpButton = await screen.findByRole('button', { name: 'Jump to bottom' });
      fireEvent.click(jumpButton);

      expect(jumpToLatest).toHaveBeenCalledWith('agent:test:main');
      expect(metrics.scrollTop).toBe(660);
      expect(rafQueue.length).toBeGreaterThan(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('正文二次渲染只导致高度变化时，不应再次自动贴底', async () => {
    useChatStore.setState({
      loadedSessions: {
        'agent:test:main': buildSessionRecord({
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
          window: createViewportWindowState({
            totalMessageCount: 2,
            windowStartOffset: 0,
            windowEndOffset: 2,
            isAtLatest: true,
          }),
          meta: {
            historyStatus: 'ready',
            lastActivityAt: Date.now(),
          },
        }),
      },
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
      triggerResizeObserver?.();
    });

    act(() => {
      metrics.scrollHeight = 1280;
      triggerResizeObserver?.();
    });

    await waitFor(() => {
      expect(metrics.scrollTop).toBe(660);
    });
  });

  it('锁底时窗口缩小导致 viewport 变矮，静态线程仍应保持贴底', async () => {
    useChatStore.setState({
      loadedSessions: {
        'agent:test:main': buildSessionRecord({
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
          window: createViewportWindowState({
            totalMessageCount: 2,
            windowStartOffset: 0,
            windowEndOffset: 2,
            isAtLatest: true,
          }),
          meta: {
            historyStatus: 'ready',
            lastActivityAt: Date.now(),
          },
        }),
      },
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
      triggerResizeObserver?.();
    });

    act(() => {
      metrics.clientHeight = 220;
      triggerResizeObserver?.();
    });

    await waitFor(() => {
      expect(metrics.scrollTop).toBe(760);
    });
  });

  it('静态线程脱离锁底后窗口缩小，不应被重新拉回到底部', async () => {
    useChatStore.setState({
      loadedSessions: {
        'agent:test:main': buildSessionRecord({
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
          window: createViewportWindowState({
            totalMessageCount: 2,
            windowStartOffset: 0,
            windowEndOffset: 2,
            isAtLatest: true,
          }),
          meta: {
            historyStatus: 'ready',
            lastActivityAt: Date.now(),
          },
        }),
      },
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
      triggerResizeObserver?.();
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

  it('静态线程脱离锁底后，上方消息因 resize 重排增高时应保持当前阅读锚点', async () => {
    useChatStore.setState({
      loadedSessions: {
        'agent:test:main': buildSessionRecord({
          messages: [
            {
              role: 'user',
              content: 'message-1',
              timestamp: Date.now() / 1000,
              id: 'user-1',
            },
            {
              role: 'assistant',
              content: 'message-2',
              timestamp: Date.now() / 1000,
              id: 'assistant-1',
            },
            {
              role: 'assistant',
              content: 'message-3',
              timestamp: Date.now() / 1000,
              id: 'assistant-2',
            },
          ],
          window: createViewportWindowState({
            totalMessageCount: 3,
            windowStartOffset: 0,
            windowEndOffset: 3,
            isAtLatest: true,
          }),
          meta: {
            historyStatus: 'ready',
            lastActivityAt: Date.now(),
          },
        }),
      },
    } as never);

    const { container } = renderChat();
    const viewport = container.querySelector('.overflow-y-auto') as HTMLDivElement;
    const rowElements = Array.from(container.querySelectorAll<HTMLElement>('[data-chat-row-key][data-chat-row-kind="message"]'));
    expect(rowElements.length).toBeGreaterThanOrEqual(2);
    const initialRowHeights = [100, 300, ...Array.from({ length: Math.max(0, rowElements.length - 2) }, () => 80)];
    const resizedRowHeights = [160, 300, ...Array.from({ length: Math.max(0, rowElements.length - 2) }, () => 80)];
    const metrics = {
      scrollHeight: initialRowHeights.reduce((sum, height) => sum + height, 0),
      clientHeight: 120,
      clientWidth: 400,
      scrollTop: 0,
    };
    installViewportMetrics(viewport, metrics);
    installViewportRect(viewport, metrics);
    installVirtualRowLayout(rowElements, metrics, initialRowHeights);

    await waitFor(() => {
      expect(metrics.scrollTop).toBe(metrics.scrollHeight - metrics.clientHeight);
    });

    act(() => {
      triggerResizeObserver?.();
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    act(() => {
      fireEvent.wheel(viewport, { deltaY: -120 });
      metrics.scrollTop = 150;
      fireEvent.scroll(viewport);
    });

    act(() => {
      metrics.clientWidth = 320;
      metrics.scrollHeight = resizedRowHeights.reduce((sum, height) => sum + height, 0);
      installViewportRect(viewport, metrics);
      installVirtualRowLayout(rowElements, metrics, resizedRowHeights);
      triggerResizeObserver?.();
    });

    await waitFor(() => {
      expect(metrics.scrollTop).toBe(210);
    });
  });

  it('锁底时 assistant final 完成后的尾部继续增高，仍应保持贴底', async () => {
    useChatStore.setState({
      loadedSessions: {
        'agent:test:main': buildSessionRecord({
          messages: [
            {
              role: 'user',
              content: 'hello',
              timestamp: Date.now() / 1000,
              id: 'user-1',
            },
            {
              role: 'assistant',
              content: 'first chunk',
              timestamp: Date.now() / 1000,
              id: 'assistant-1',
            },
          ],
          window: createViewportWindowState({
            totalMessageCount: 2,
            windowStartOffset: 0,
            windowEndOffset: 2,
            isAtLatest: true,
          }),
          meta: {
            historyStatus: 'ready',
            lastActivityAt: Date.now(),
          },
          runtime: {
            sending: true,
            activeRunId: 'run-1',
            runPhase: 'streaming',
            lastUserMessageAt: Date.now(),
          },
        }),
      },
    } as never);

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

    await waitFor(() => {
      expect(metrics.scrollTop).toBe(660);
    });

    act(() => {
      useChatStore.setState({
        loadedSessions: {
          'agent:test:main': {
            ...useChatStore.getState().loadedSessions['agent:test:main'],
            runtime: {
              ...useChatStore.getState().loadedSessions['agent:test:main']!.runtime,
              sending: false,
              activeRunId: null,
              runPhase: 'done',
              pendingFinal: false,
            },
          },
        },
      } as never);
    });

    act(() => {
      metrics.scrollHeight = 1400;
      triggerResizeObserver?.();
    });

    await waitFor(() => {
      expect(metrics.scrollTop).toBe(1080);
    });
  });

  it('同会话加载更早消息后，应保持当前阅读锚点不跳动', async () => {
    const loadOlderMessages = vi.fn().mockResolvedValue(undefined);
    useChatStore.setState({
      loadedSessions: {
        'agent:test:main': buildSessionRecord({
          messages: [
            {
              role: 'user',
              content: 'message-0',
              timestamp: 0,
              id: 'user-0',
            },
            {
              role: 'assistant',
              content: 'message-0.5',
              timestamp: 0.5,
              id: 'assistant-0',
            },
            {
              role: 'user',
              content: 'older message',
              timestamp: 0.75,
              id: 'user-older',
            },
            {
              role: 'user',
              content: 'message-1',
              timestamp: 1,
              id: 'user-1',
            },
            {
              role: 'assistant',
              content: 'message-2',
              timestamp: 2,
              id: 'assistant-1',
            },
            {
              role: 'assistant',
              content: 'message-3',
              timestamp: 3,
              id: 'assistant-2',
            },
          ],
          window: createViewportWindowState({
            totalMessageCount: 6,
            windowStartOffset: 3,
            windowEndOffset: 6,
            hasMore: true,
            isAtLatest: true,
          }),
          meta: {
            historyStatus: 'ready',
            lastActivityAt: Date.now(),
          },
        }),
      },
      loadOlderMessages,
    } as never);

    const { container } = renderChat();
    const viewport = container.querySelector('.overflow-y-auto') as HTMLDivElement;
    const metrics = {
      scrollHeight: 300,
      clientHeight: 100,
      clientWidth: 400,
      scrollTop: 200,
    };
    installViewportMetrics(viewport, metrics);
    installViewportRect(viewport, metrics);

    let rowElements = Array.from(container.querySelectorAll<HTMLElement>('[data-chat-row-key][data-chat-row-kind="message"]'));
    installVirtualRowLayout(rowElements, metrics, [80, 120, 100]);

    await waitFor(() => {
      expect(metrics.scrollTop).toBe(200);
    });

    act(() => {
      fireEvent.wheel(viewport, { deltaY: -120 });
      metrics.scrollTop = 60;
      fireEvent.scroll(viewport);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Load older messages' }));
    expect(loadOlderMessages).toHaveBeenCalledWith('agent:test:main');

    act(() => {
      metrics.scrollHeight = 370;
      useChatStore.setState({
        loadedSessions: {
          'agent:test:main': buildSessionRecord({
            messages: [
              {
                role: 'user',
                content: 'message-0',
                timestamp: 0,
                id: 'user-0',
              },
              {
                role: 'assistant',
                content: 'message-0.5',
                timestamp: 0.5,
                id: 'assistant-0',
              },
              {
                role: 'user',
                content: 'older message',
                timestamp: 0.75,
                id: 'user-older',
              },
              {
                role: 'user',
                content: 'message-1',
                timestamp: 1,
                id: 'user-1',
              },
              {
                role: 'assistant',
                content: 'message-2',
                timestamp: 2,
                id: 'assistant-1',
              },
              {
                role: 'assistant',
                content: 'message-3',
                timestamp: 3,
                id: 'assistant-2',
              },
            ],
            window: createViewportWindowState({
              totalMessageCount: 6,
              windowStartOffset: 2,
              windowEndOffset: 6,
              hasMore: true,
              isAtLatest: true,
            }),
          meta: {
              historyStatus: 'ready',
              lastActivityAt: Date.now(),
            },
          }),
        },
      } as never);
    });

    rowElements = Array.from(container.querySelectorAll<HTMLElement>('[data-chat-row-key][data-chat-row-kind="message"]'));
    installVirtualRowLayout(rowElements, metrics, [70, 80, 120, 100]);

    await waitFor(() => {
      expect(metrics.scrollTop).toBe(130);
    });
  });

  it('锁底时尾部内容继续增高，也应继续贴底', async () => {
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
      metrics.scrollHeight = 1220;
      triggerResizeObserver?.();
    });

    await waitFor(() => {
      expect(metrics.scrollTop).toBe(900);
    });
  });

  it('helper 只按真实布局量判断近底和目标滚动位', () => {
    expect(isChatViewportNearBottom({
      scrollHeight: 1000,
      clientHeight: 300,
      scrollTop: 690,
      clientWidth: 800,
    }, 12)).toBe(true);

    expect(isChatViewportNearBottom({
      scrollHeight: 1000,
      clientHeight: 300,
      scrollTop: 650,
      clientWidth: 800,
    }, 12)).toBe(false);

    expect(computeBottomLockedScrollTopOnResize(
      { scrollHeight: 900, clientHeight: 300, scrollTop: 600, clientWidth: 800 },
      { scrollHeight: 1180, clientHeight: 320, scrollTop: 0, clientWidth: 800 },
    )).toBe(860);
  });
});
