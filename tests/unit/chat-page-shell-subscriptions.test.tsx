import { act, render, screen } from '@testing-library/react';
import { forwardRef, type ReactNode, useImperativeHandle } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Chat from '@/pages/Chat';
import { useChatStore } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import { useSubagentsStore } from '@/stores/subagents';
import { createEmptySessionRecord } from '@/stores/chat/store-state-helpers';
import { createViewportWindowState } from '@/stores/chat/viewport-state';
import { buildRenderItemsFromMessages } from './helpers/timeline-fixtures';

const chatViewportPaneRenderSpy = vi.fn();

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string) => key,
    }),
  };
});

vi.mock('@/pages/Chat/useChatInit', () => ({
  useChatInit: () => {},
}));

vi.mock('@/pages/Chat/useChatSidePanelController', () => ({
  useChatSidePanelController: () => ({
    sidePanelOpen: false,
    sidePanelMode: 'hidden',
    sidePanelWidth: 0,
    activeSidePanelTab: 'tasks',
    unfinishedTaskCount: 0,
    toggleSidePanel: vi.fn(),
    setActiveSidePanelTab: vi.fn(),
    closeSidePanel: vi.fn(),
  }),
}));

vi.mock('@/pages/Chat/useSkillConfig', () => ({
  useSkillConfig: () => ({
    saving: false,
    selectedSkillIds: [],
    availableSkillOptions: [],
    skillsLoading: false,
    prepare: vi.fn(),
    resetSession: vi.fn(),
    toggleSkill: vi.fn(),
    save: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('@/pages/Chat/components/ChatShell', () => ({
  ChatShell: ({
    header,
    viewportPane,
    errorBanner,
    approvalDock,
    input,
  }: {
    header: ReactNode;
    viewportPane: ReactNode;
    errorBanner: ReactNode;
    approvalDock: ReactNode;
    input: ReactNode;
  }) => {
    return (
      <div data-testid="chat-shell">
        {header}
        {viewportPane}
        {errorBanner}
        {approvalDock}
        {input}
      </div>
    );
  },
}));

vi.mock('@/pages/Chat/components/ChatHeaderBar', () => ({
  ChatHeaderBar: () => <div data-testid="chat-header-bar" />,
}));

vi.mock('@/pages/Chat/components/ChatRuntimeDock', () => ({
  ChatErrorBanner: ({ error }: { error: string }) => (
    <div data-testid="chat-error-banner">{error}</div>
  ),
  ChatApprovalDock: () => <div data-testid="chat-approval-dock" />,
}));

vi.mock('@/pages/Chat/ChatInput', () => ({
  ChatInput: () => <div data-testid="chat-input" />,
}));

vi.mock('@/pages/Chat/components/ChatOffline', () => ({
  ChatOffline: ({
    title,
    description,
  }: {
    title: string;
    description: string;
  }) => (
    <div data-testid="chat-offline">
      <div data-testid="chat-offline-title">{title}</div>
      <div data-testid="chat-offline-description">{description}</div>
    </div>
  ),
}));

vi.mock('@/pages/Chat/components/ChatList', () => ({
  ChatList: forwardRef(function MockChatViewportPane(
    props: {
      currentSession: ReturnType<typeof createEmptySessionRecord>;
    },
    ref,
  ) {
    chatViewportPaneRenderSpy();
    useImperativeHandle(ref, () => ({
      prepareCurrentLatestBottomAlign: vi.fn(),
    }), []);
    return (
      <div data-testid="chat-viewport-pane">
        {props.currentSession.items.length}
      </div>
    );
  }),
}));

function buildSessionRecord(overrides?: Partial<ReturnType<typeof createEmptySessionRecord>> & {
  sessionKey?: string;
  messages?: Array<{ id?: string; role: 'user' | 'assistant' | 'system'; content: unknown; timestamp?: number; streaming?: boolean }>;
}) {
  const base = createEmptySessionRecord();
  const sessionKey = overrides?.sessionKey ?? 'agent:main:main';
  return {
    meta: {
      ...base.meta,
      ...overrides?.meta,
    },
    runtime: {
      ...base.runtime,
      ...overrides?.runtime,
    },
    items: overrides?.messages
      ? buildRenderItemsFromMessages(sessionKey, overrides.messages)
      : (overrides?.items ?? base.items),
    window: overrides?.window ?? base.window,
  };
}

describe('chat 顶层订阅收口', () => {
  const activeRunDisconnectedError = 'The active run disconnected before a terminal event was received.';

  beforeEach(() => {
    chatViewportPaneRenderSpy.mockClear();

    useGatewayStore.setState({
      status: {
        processState: 'running',
        port: 18789,
        gatewayReady: true,
        healthSummary: 'healthy',
        transportState: 'connected',
        portReachable: true,
        diagnostics: {
          consecutiveHeartbeatMisses: 0,
          consecutiveRpcFailures: 0,
        },
        updatedAt: 1,
      },
      rpc: vi.fn(),
    } as never);

    useSubagentsStore.setState({
      agentsResource: {
        status: 'ready',
        data: [
          { id: 'main', name: 'Main', workspace: '.', isDefault: true, createdAt: 1, updatedAt: 1 },
        ],
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      loadAgents: vi.fn().mockResolvedValue(undefined),
      updateAgent: vi.fn().mockResolvedValue(undefined),
    } as never);

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      loadedSessions: {
        'agent:main:main': buildSessionRecord({
          sessionKey: 'agent:main:main',
          messages: [
            {
              id: 'assistant-1',
              role: 'assistant',
              content: 'first chunk',
              timestamp: 1,
              streaming: true,
            },
          ],
          runtime: {
            sending: true,
          },
          window: createViewportWindowState({
            totalItemCount: 1,
            windowStartOffset: 0,
            windowEndOffset: 1,
            isAtLatest: true,
          }),
        }),
      },
      pendingApprovalsBySession: {},
      foregroundHistorySessionKey: null,
      sessionCatalogStatus: {
        status: 'ready',
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      mutating: false,
      error: null,
      showThinking: true,
      switchSession: vi.fn(),
      openAgentConversation: vi.fn(),
      loadHistory: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
      cleanupEmptySession: vi.fn(),
      loadOlderViewportItems: vi.fn().mockResolvedValue(undefined),
      jumpViewportToLatest: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      abortRun: vi.fn().mockResolvedValue(undefined),
      clearError: vi.fn(),
      resolveApproval: vi.fn().mockResolvedValue(undefined),
      refresh: vi.fn().mockResolvedValue(undefined),
      toggleThinking: vi.fn(),
    } as never);
  });

  it('流式消息增长时，应继续通过当前页面壳把最新 viewport 内容渲染出来', () => {
    render(
      <MemoryRouter>
        <Chat isActive={false} />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('chat-shell')).toBeInTheDocument();
    expect(screen.getByTestId('chat-viewport-pane')).toBeInTheDocument();
    expect(screen.getByTestId('chat-input')).toBeInTheDocument();

    const viewportRenderCountAfterMount = chatViewportPaneRenderSpy.mock.calls.length;

    act(() => {
      useChatStore.setState((state) => ({
        loadedSessions: {
          ...state.loadedSessions,
          'agent:main:main': buildSessionRecord({
            sessionKey: 'agent:main:main',
            messages: [
              {
                id: 'assistant-1',
                role: 'assistant',
                content: 'first chunk second chunk',
                timestamp: 1,
                streaming: true,
              },
            ],
            runtime: {
              ...state.loadedSessions['agent:main:main']!.runtime,
              sending: true,
            },
            window: createViewportWindowState({
              totalItemCount: 1,
              windowStartOffset: 0,
              windowEndOffset: 1,
              isAtLatest: true,
            }),
          }),
        },
      }));
    });

    expect(chatViewportPaneRenderSpy).toHaveBeenCalledTimes(viewportRenderCountAfterMount + 1);
    expect(screen.getByTestId('chat-shell')).toBeInTheDocument();
    expect(screen.getByTestId('chat-input')).toBeInTheDocument();
  });

  it('当前会话 runtime.lastError 存在时应展示错误 banner', () => {
    useChatStore.setState((state) => ({
      loadedSessions: {
        ...state.loadedSessions,
        'agent:main:main': buildSessionRecord({
          sessionKey: 'agent:main:main',
          runtime: {
            ...state.loadedSessions['agent:main:main']!.runtime,
            lastError: 'model unavailable',
          },
        }),
      },
      error: null,
    }));

    render(
      <MemoryRouter>
        <Chat isActive={false} />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('chat-error-banner')).toBeInTheDocument();
  });

  it('已知运行时断连错误应映射为本地化文案 key', () => {
    useChatStore.setState((state) => ({
      loadedSessions: {
        ...state.loadedSessions,
        'agent:main:main': buildSessionRecord({
          sessionKey: 'agent:main:main',
          runtime: {
            ...state.loadedSessions['agent:main:main']!.runtime,
            lastError: activeRunDisconnectedError,
          },
        }),
      },
      error: null,
    }));

    render(
      <MemoryRouter>
        <Chat isActive={false} />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('chat-error-banner')).toHaveTextContent('errors.activeRunDisconnected');
  });

  it('gateway transport 断开时，离线页应显示具体 transport 错误原因', () => {
    useGatewayStore.setState({
      status: {
        processState: 'running',
        port: 18789,
        gatewayReady: false,
        healthSummary: 'unresponsive',
        transportState: 'disconnected',
        portReachable: false,
        lastError: 'Gateway socket closed: code=1006 reason=network down',
        lastIssue: {
          message: 'Gateway socket closed: code=1006 reason=network down',
          source: 'socket-close',
          at: 1,
          code: '1006',
          details: { reason: 'network down' },
        },
        diagnostics: {
          consecutiveHeartbeatMisses: 1,
          consecutiveRpcFailures: 0,
        },
        updatedAt: 2,
      },
    } as never);

    render(
      <MemoryRouter>
        <Chat isActive={false} />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('chat-offline')).toBeInTheDocument();
    expect(screen.getByTestId('chat-offline-description')).toHaveTextContent(
      'errors.gatewaySocketClosed',
    );
  });

  it('当前会话仍在发送时，应优先把 gateway transport issue 映射为本地化错误 banner', () => {
    useGatewayStore.setState({
      status: {
        processState: 'running',
        port: 18789,
        gatewayReady: true,
        healthSummary: 'degraded',
        transportState: 'connected',
        portReachable: true,
        lastError: 'Gateway RPC timeout: chat.send',
        lastIssue: {
          message: 'Gateway RPC timeout: chat.send',
          source: 'rpc',
          at: 1,
        },
        diagnostics: {
          consecutiveHeartbeatMisses: 0,
          consecutiveRpcFailures: 1,
        },
        updatedAt: 2,
      },
    } as never);
    useChatStore.setState((state) => ({
      loadedSessions: {
        ...state.loadedSessions,
        'agent:main:main': buildSessionRecord({
          sessionKey: 'agent:main:main',
          runtime: {
            ...state.loadedSessions['agent:main:main']!.runtime,
            sending: true,
            pendingFinal: false,
            runPhase: 'submitted',
            lastError: null,
          },
        }),
      },
    }));

    render(
      <MemoryRouter>
        <Chat isActive={false} />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('chat-error-banner')).toHaveTextContent('errors.gatewayRpcTimeout');
  });

  it('当前会话 runtime.lastIssue 的错误码应优先映射为本地化文案 key', () => {
    useChatStore.setState((state) => ({
      loadedSessions: {
        ...state.loadedSessions,
        'agent:main:main': buildSessionRecord({
          sessionKey: 'agent:main:main',
          runtime: {
            ...state.loadedSessions['agent:main:main']!.runtime,
            sending: false,
            runPhase: 'error',
            lastError: null,
            lastIssue: {
              message: 'model unavailable',
              source: 'runtime',
              at: 1,
              code: 'MODEL_UNAVAILABLE',
              details: { provider: 'anthropic' },
            },
          },
        }),
      },
      error: null,
    }));

    render(
      <MemoryRouter>
        <Chat isActive={false} />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('chat-error-banner')).toHaveTextContent('errors.modelUnavailable');
  });
});
