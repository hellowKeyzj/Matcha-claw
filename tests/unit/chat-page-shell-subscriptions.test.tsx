import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { forwardRef, type ReactNode, useImperativeHandle } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Chat from '@/pages/Chat';
import { useChatStore as realUseChatStore } from '@/stores/chat';
import { useRuntimeHostStore } from '@/stores/gateway';
import { useSubagentsStore } from '@/stores/subagents';
import { useTeamsStore } from '@/stores/teams';
import { useRuntimeEndpointsStore } from '@/stores/runtime-endpoints';
import { createEmptySessionRecord } from '@/stores/chat/store-state-helpers';
import { buildCurrentConversationFromSessionRecord, buildSessionRuntimeGraph } from '@/stores/chat/session-runtime-graph';
import { createViewportWindowState } from '@/stores/chat/viewport-state';
import type { RuntimeEndpointSummary } from '@/types/runtime-topology';
import type { RuntimeEndpointRef } from '../../electron/desktop-contract/runtime-address';
import { buildRenderItemsFromMessages } from './helpers/timeline-fixtures';
import { createOpenClawTestSessionIdentity, openClawTestRuntimeEndpoint } from './helpers/runtime-address-fixtures';

const chatViewportPaneRenderSpy = vi.fn();
const chatInputSendResultSpy = vi.fn();
const useChatInitSpy = vi.fn();
const useChatSidePanelControllerSpy = vi.fn();
const useChatStore = realUseChatStore;

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string) => key,
    }),
  };
});

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
  },
}));

vi.mock('@/pages/Chat/useChatInit', () => ({
  useChatInit: (input: unknown) => {
    useChatInitSpy(input);
  },
}));

vi.mock('@/pages/Chat/useChatSidePanelController', () => ({
  useChatSidePanelController: (enabled: boolean) => {
    useChatSidePanelControllerSpy(enabled);
    return {
      sidePanelOpen: false,
      sidePanelMode: 'docked',
      sidePanelWidth: 360,
      sidePanelPreferredWidth: 360,
      sidePanelWidthPolicy: 'light',
      activeSidePanelTab: 'tasks',
      artifactWorkbenchFullscreen: false,
      unfinishedTaskCount: 0,
      taskInboxTasks: [],
      taskInboxLoading: false,
      taskInboxError: null,
      refreshTaskInbox: vi.fn(),
      clearTaskInboxError: vi.fn(),
      derivedPlanStatus: null,
      openSidePanel: vi.fn(),
      setActiveSidePanelTab: vi.fn(),
      closeSidePanel: vi.fn(),
      setSidePanelWidth: vi.fn(),
      toggleArtifactWorkbenchFullscreen: vi.fn(),
    };
  },
}));

vi.mock('@/pages/Chat/useChatWindowDockController', () => ({
  useChatWindowDockController: () => ({
    phase: 'closed',
    sidePanelMounted: false,
    sidePanelExpanded: false,
    sidePanelMode: 'docked',
    sidePanelWidth: 360,
    sidePanelMainWidth: null,
    sidePanelVisible: true,
    toggleSidePanel: vi.fn(),
    openSidePanel: vi.fn(),
    closeSidePanel: vi.fn(),
    resizeSidePanelWidth: vi.fn(),
    commitSidePanelWidth: vi.fn(),
  }),
}));

vi.mock('@/pages/Chat/useAgentSkillConfig', () => ({
  useAgentSkillConfig: () => ({
    selectedSkillIds: [],
    allowedSkillIdsForChat: [],
    availableSkillOptions: [],
    skillsLoading: false,
    prepare: vi.fn(),
    resetSession: vi.fn(),
    toggleSkill: vi.fn(),
  }),
}));

vi.mock('@/pages/Chat/components/ChatShell', () => ({
  ChatShell: ({
    header,
    viewportPane,
    errorBanner,
    approvalDock,
    todoPanel,
    input,
  }: {
    header: ReactNode;
    viewportPane: ReactNode;
    errorBanner: ReactNode;
    approvalDock: ReactNode;
    todoPanel?: ReactNode;
    input: ReactNode;
  }) => {
    return (
      <div data-testid="chat-shell">
        {header}
        {viewportPane}
        {errorBanner}
        {approvalDock}
        {todoPanel}
        {input}
      </div>
    );
  },
}));

vi.mock('@/pages/Chat/components/ChatHeaderBar', () => ({
  ChatHeaderBar: () => <div data-testid="chat-header-bar" />,
}));

vi.mock('@/pages/Chat/components/ChatRuntimeDock', () => ({
  ChatErrorBanner: ({
    error,
    onDismiss,
  }: {
    error: string;
    onDismiss: () => void;
  }) => (
    <div data-testid="chat-error-banner">
      <span>{error}</span>
      <button type="button" onClick={onDismiss}>dismiss</button>
    </div>
  ),
  ChatApprovalDock: () => <div data-testid="chat-approval-dock" />,
}));

vi.mock('@/pages/Chat/ChatInput', () => ({
  ChatInput: ({
    disabled,
    reconnecting,
    onSend,
  }: {
    disabled?: boolean;
    reconnecting?: boolean;
    onSend: (text: string, attachments?: unknown[]) => Promise<unknown>;
  }) => (
    <>
      <button
        type="button"
        data-testid="chat-input"
        data-disabled={disabled ? 'true' : 'false'}
        data-reconnecting={reconnecting ? 'true' : 'false'}
        onClick={() => { void onSend('hello from test').then(chatInputSendResultSpy); }}
      >
        send
      </button>
      <button
        type="button"
        data-testid="chat-input-with-attachment"
        onClick={() => {
          void onSend('hello from test', [{
            id: 'file-1',
            fileName: 'brief.txt',
            mimeType: 'text/plain',
            fileSize: 12,
            stagedAttachmentId: 'attachment-brief',
            preview: null,
            status: 'ready',
          }]).then(chatInputSendResultSpy);
        }}
      >
        send attachment
      </button>
    </>
  ),
}));

vi.mock('@/pages/Chat/components/ChatOffline', () => ({
  ChatOffline: ({
    title,
    description,
    tone,
  }: {
    title: string;
    description: string;
    tone?: string;
  }) => (
    <div data-testid="chat-offline" data-tone={tone ?? 'error'}>
      <div data-testid="chat-offline-title">{title}</div>
      <div data-testid="chat-offline-description">{description}</div>
    </div>
  ),
}));

vi.mock('@/pages/Chat/components/ChatList', () => ({
  ChatList: forwardRef(function MockChatViewportPane(
    props: {
      items: ReturnType<typeof createEmptySessionRecord>['items'];
    },
    ref,
  ) {
    chatViewportPaneRenderSpy();
    useImperativeHandle(ref, () => ({
      prepareCurrentLatestBottomAlign: vi.fn(),
    }), []);
    return (
      <div data-testid="chat-viewport-pane">
        {props.items.length}
      </div>
    );
  }),
}));

function buildRuntimeEndpoint(endpoint: Extract<RuntimeEndpointRef, { kind: 'native-runtime' }>): RuntimeEndpointSummary {
  return {
    id: `${endpoint.runtimeAdapterId}-local`,
    protocolId: endpoint.runtimeAdapterId === 'matcha-agent' ? 'matcha-agent-app-server' : 'openclaw-v4',
    runtimeAdapterId: endpoint.runtimeAdapterId,
    runtimeInstanceId: endpoint.runtimeInstanceId,
    endpointRef: endpoint,
    source: {
      kind: 'runtime-adapter',
      runtimeAdapterId: endpoint.runtimeAdapterId,
      runtimeInstanceId: endpoint.runtimeInstanceId,
    },
    location: { kind: 'local' },
    lifecycle: { phase: 'ready', connected: true, ready: true, updatedAt: null },
    displayName: endpoint.runtimeAdapterId,
    agentIds: [endpoint.runtimeAdapterId === 'matcha-agent' ? 'matcha' : 'main'],
    defaultAgentId: endpoint.runtimeAdapterId === 'matcha-agent' ? 'matcha' : 'main',
    agents: [],
    acceptsDynamicAgents: true,
    capabilities: {
      chat: true,
      streaming: true,
      tools: true,
      approvals: true,
      replay: true,
      modelSelection: true,
    },
    capabilityFamilies: [{ family: 'session', availability: 'supported' }],
    controlState: {
      connection: null,
      readiness: { ready: true, phase: 'ready' },
      capabilities: null,
      updatedAt: null,
    },
  };
}

function buildSessionRecord(overrides?: Partial<ReturnType<typeof createEmptySessionRecord>> & {
  sessionKey?: string;
  messages?: Array<{ id?: string; role: 'user' | 'assistant' | 'system'; content: unknown; timestamp?: number; streaming?: boolean }>;
}) {
  const base = createEmptySessionRecord();
  const sessionKey = overrides?.sessionKey ?? 'agent:main:main';
  const sessionIdentity = createOpenClawTestSessionIdentity(sessionKey);
  return {
    meta: {
      ...base.meta,
      agentId: sessionKey.split(':')[1] ?? null,
      sessionIdentity,
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
    vi.clearAllMocks();
    chatViewportPaneRenderSpy.mockClear();
    chatInputSendResultSpy.mockClear();
    useChatInitSpy.mockClear();
    useChatSidePanelControllerSpy.mockClear();

    useRuntimeHostStore.setState({
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
      runtimeHost: { lifecycle: 'running' },
      isInitialized: true,
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

    useTeamsStore.setState({
      teams: [],
      activeTeamId: null,
      runIdsByTeamId: {},
      runListByTeamId: {},
      rolesByTeamId: {},
      nodeExecutionsByTeamId: {},
      nodePromptDeliveryAttemptsByTeamId: {},
    } as never);

    useRuntimeEndpointsStore.setState({
      status: 'ready',
      error: null,
      endpoints: [buildRuntimeEndpoint(openClawTestRuntimeEndpoint)],
      hasLoadedOnce: true,
      revision: 0,
      changedRuntimeScopeKeys: [],
      revisionByRuntimeScopeKey: {},
    });

    const mainRecord = buildSessionRecord({
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
        updatedAt: null,
      },
      window: createViewportWindowState({
        totalItemCount: 1,
        windowStartOffset: 0,
        windowEndOffset: 1,
        isAtLatest: true,
      }),
    });
    const mainSessionRuntimeCatalog = {
      status: 'ready' as const,
      error: null,
      endpoints: [{
        endpointId: 'openclaw-default',
        protocolId: 'openclaw',
        endpoint: openClawTestRuntimeEndpoint,
        runtimeAdapterId: 'openclaw',
        runtimeInstanceId: 'default',
        displayName: 'OpenClaw',
        agentIds: ['main'],
        acceptsDynamicAgents: true,
        agentCatalog: {
          source: 'subagent-management' as const,
          seedAgents: [{ id: 'main', name: 'main' }],
        },
        sessionPromptScopes: [{ kind: 'agent' as const, endpoint: openClawTestRuntimeEndpoint, agentId: 'main' }],
        defaultSessionPromptScope: { kind: 'agent' as const, endpoint: openClawTestRuntimeEndpoint, agentId: 'main' },
      }],
      defaultSessionPromptScope: { kind: 'agent' as const, endpoint: openClawTestRuntimeEndpoint, agentId: 'main' },
    };
    const loadedSessions = { 'agent:main:main': mainRecord };
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentConversation: buildCurrentConversationFromSessionRecord(mainRecord),
      loadedSessions,
      pendingApprovalsBySession: {},
      foregroundHistorySessionKey: null,
      sessionRuntimeCatalog: mainSessionRuntimeCatalog,
      sessionRuntimeGraph: buildSessionRuntimeGraph(mainSessionRuntimeCatalog, loadedSessions),
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
      clearError: realUseChatStore.getState().clearError,
      resolveApproval: vi.fn().mockResolvedValue(undefined),
      refresh: vi.fn().mockResolvedValue(undefined),
      toggleThinking: vi.fn(),
    } as never);
  });

  it('Matcha endpoint 可用时，OpenClaw gateway degraded 与 Runtime Host degraded 不阻断 Chat shell', () => {
    const bootstrapSessionRuntime = vi.fn().mockResolvedValue(undefined);
    const matchaEndpoint = {
      kind: 'native-runtime' as const,
      runtimeAdapterId: 'matcha-agent' as const,
      runtimeInstanceId: 'local',
    };
    const matchaAgentScope = { kind: 'agent' as const, endpoint: matchaEndpoint, agentId: 'matcha' };

    useRuntimeHostStore.setState((state) => ({
      ...state,
      status: {
        processState: 'control_connecting',
        port: 18789,
        gatewayReady: false,
        healthSummary: 'degraded',
        transportState: 'reconnecting',
        portReachable: true,
        diagnostics: {
          consecutiveHeartbeatMisses: 0,
          consecutiveRpcFailures: 0,
        },
        updatedAt: 2,
      },
      runtimeHost: { lifecycle: 'degraded' },
      isInitialized: true,
    } as never));
    useChatStore.setState((state) => ({
      ...state,
      currentSessionKey: 'matcha-agent:matcha:main',
      loadedSessions: {
        'matcha-agent:matcha:main': buildSessionRecord({
          sessionKey: 'matcha-agent:matcha:main',
          meta: {
            agentId: 'matcha',
            sessionIdentity: {
              endpoint: matchaEndpoint,
              agentId: 'matcha',
              sessionKey: 'matcha-agent:matcha:main',
            },
          },
        }),
      },
      sessionRuntimeCatalog: {
        status: 'ready',
        error: null,
        endpoints: [{
          endpointId: 'matcha-agent-local',
          protocolId: 'matcha-agent',
          endpoint: matchaEndpoint,
          runtimeAdapterId: 'matcha-agent',
          runtimeInstanceId: 'local',
          displayName: 'Matcha Agent',
          agentIds: ['matcha'],
          acceptsDynamicAgents: false,
          sessionPromptScopes: [matchaAgentScope],
          defaultSessionPromptScope: matchaAgentScope,
        }],
        defaultSessionPromptScope: matchaAgentScope,
      },
      bootstrapSessionRuntime,
    } as never));
    useRuntimeEndpointsStore.setState((state) => ({
      ...state,
      endpoints: [buildRuntimeEndpoint(matchaEndpoint)],
      changedRuntimeScopeKeys: [],
    } as never));

    render(
      <MemoryRouter>
        <Chat />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('chat-shell')).toBeInTheDocument();
    expect(screen.getByTestId('chat-input')).toHaveAttribute('data-disabled', 'false');
  });

  it('普通 Agent 会话发送仍走普通 chat send，即使 agent 名叫 leader', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    useChatStore.setState((state) => ({
      currentSessionKey: 'agent:leader:main',
      loadedSessions: {
        ...state.loadedSessions,
        'agent:leader:main': buildSessionRecord({
          sessionKey: 'agent:leader:main',
          meta: { agentId: 'leader' },
        }),
      },
      sendMessage,
    } as never));

    render(
      <MemoryRouter>
        <Chat isActive={false} />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByTestId('chat-input'));

    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith('hello from test', undefined));
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
            updatedAt: 2,
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
            updatedAt: 2,
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

  it('全局 catalog loading 时仍保留已有当前会话内容', () => {
    useChatStore.setState((state) => {
      const current = buildSessionRecord({
        sessionKey: 'agent:main:main',
        messages: [{ id: 'assistant-1', role: 'assistant', content: 'hi', timestamp: 1 }],
        window: createViewportWindowState({
          totalItemCount: 1,
          windowStartOffset: 0,
          windowEndOffset: 1,
          isAtLatest: true,
        }),
      });
      const catalog = {
        ...state.sessionRuntimeCatalog,
        status: 'loading' as const,
      };
      const loadedSessions = { 'agent:main:main': current };
      return {
        currentSessionKey: 'agent:main:main',
        loadedSessions,
        currentConversation: null,
        sessionRuntimeCatalog: catalog,
        sessionRuntimeGraph: buildSessionRuntimeGraph(catalog, loadedSessions),
      };
    });

    render(
      <MemoryRouter>
        <Chat isActive={false} />
      </MemoryRouter>,
    );

    expect(screen.queryByTestId('chat-offline')).not.toBeInTheDocument();
    expect(screen.getByTestId('chat-shell')).toBeInTheDocument();
    expect(screen.getByTestId('chat-viewport-pane')).toHaveTextContent('1');
  });

  it('Runtime Host 恢复到 running 后保留 Chat 内容并启用输入框', () => {
    render(
      <MemoryRouter>
        <Chat isActive={false} />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('chat-shell')).toBeInTheDocument();
    expect(screen.getByTestId('chat-input')).toHaveAttribute('data-disabled', 'false');

    act(() => {
      useRuntimeHostStore.setState({
        isInitialized: true,
        runtimeHost: { lifecycle: 'running' },
      } as never);
    });

    expect(screen.queryByTestId('chat-offline')).not.toBeInTheDocument();
    expect(screen.getByTestId('chat-shell')).toBeInTheDocument();
    expect(screen.getByTestId('chat-viewport-pane')).toHaveTextContent('1');
    expect(screen.getByTestId('chat-input')).toHaveAttribute('data-disabled', 'false');
    expect(screen.getByTestId('chat-input')).toHaveAttribute('data-reconnecting', 'false');
  });

  it('运行中的 Runtime Host 不会伪装为 Gateway transport 恢复状态', () => {
    useRuntimeHostStore.setState({
      isInitialized: true,
      runtimeHost: { lifecycle: 'running' },
    } as never);

    render(
      <MemoryRouter>
        <Chat isActive={false} />
      </MemoryRouter>,
    );

    expect(screen.queryByTestId('chat-offline')).not.toBeInTheDocument();
    expect(screen.getByTestId('chat-shell')).toBeInTheDocument();
  });

  it('Runtime Host 停止且没有 ready catalog 时离线页只显示通用 runtime unavailable 状态', () => {
    useRuntimeHostStore.setState({
      status: {
        processState: 'stopped',
        port: 18789,
        gatewayReady: false,
        healthSummary: 'unresponsive',
        transportState: 'disconnected',
        portReachable: false,
        diagnostics: {
          consecutiveHeartbeatMisses: 0,
          consecutiveRpcFailures: 0,
        },
        updatedAt: 2,
      },
      isInitialized: true,
      runtimeHost: { lifecycle: 'stopped' },
    } as never);
    useRuntimeEndpointsStore.setState((state) => ({
      ...state,
      endpoints: [],
      changedRuntimeScopeKeys: [],
    } as never));
    useChatStore.setState((state) => ({
      ...state,
      currentSessionKey: '',
      currentConversation: null,
      loadedSessions: {},
      sessionRuntimeGraph: { endpoints: [] },
      sessionRuntimeCatalog: {
        status: 'ready',
        error: null,
        endpoints: [],
        defaultSessionPromptScope: null,
      },
    } as never));

    render(
      <MemoryRouter>
        <Chat isActive={false} />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('chat-offline')).toBeInTheDocument();
    expect(screen.getByTestId('chat-offline')).toHaveAttribute('data-tone', 'error');
    expect(screen.getByTestId('chat-offline-title')).toHaveTextContent('runtimeUnavailable.title');
    expect(screen.getByTestId('chat-offline-description')).toHaveTextContent('runtimeUnavailable.description');
  });

  it('Runtime Host 错误且没有 ready catalog 时离线页只显示通用 runtime unavailable 状态', () => {
    useRuntimeHostStore.setState({
      status: {
        processState: 'error',
        port: 18789,
        gatewayReady: false,
        healthSummary: 'unresponsive',
        transportState: 'disconnected',
        portReachable: false,
        diagnostics: {
          consecutiveHeartbeatMisses: 0,
          consecutiveRpcFailures: 0,
        },
        updatedAt: 2,
      },
      isInitialized: true,
      runtimeHost: { lifecycle: 'error' },
    } as never);
    useRuntimeEndpointsStore.setState((state) => ({
      ...state,
      endpoints: [],
      changedRuntimeScopeKeys: [],
    } as never));
    useChatStore.setState((state) => ({
      ...state,
      currentSessionKey: '',
      currentConversation: null,
      loadedSessions: {},
      sessionRuntimeGraph: { endpoints: [] },
      sessionRuntimeCatalog: {
        status: 'ready',
        error: null,
        endpoints: [],
        defaultSessionPromptScope: null,
      },
    } as never));

    render(
      <MemoryRouter>
        <Chat isActive={false} />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('chat-offline')).toBeInTheDocument();
    expect(screen.getByTestId('chat-offline')).toHaveAttribute('data-tone', 'error');
    expect(screen.getByTestId('chat-offline-title')).toHaveTextContent('runtimeUnavailable.title');
    expect(screen.getByTestId('chat-offline-description')).toHaveTextContent('runtimeUnavailable.description');
  });

  it('session runtime catalog 仍在加载时，应显示准备中而不是断连错误', () => {
    useRuntimeHostStore.setState({
      status: {
        processState: 'control_connecting',
        port: 18789,
        gatewayReady: false,
        healthSummary: 'unresponsive',
        transportState: 'disconnected',
        portReachable: false,
        diagnostics: {
          consecutiveHeartbeatMisses: 0,
          consecutiveRpcFailures: 0,
        },
        updatedAt: 2,
      },
      isInitialized: false,
      runtimeHost: { lifecycle: 'starting' },
    } as never);
    useRuntimeEndpointsStore.setState((state) => ({
      ...state,
      status: 'loading',
      endpoints: [],
      changedRuntimeScopeKeys: [],
    } as never));
    useChatStore.setState((state) => ({
      ...state,
      currentSessionKey: '',
      currentConversation: null,
      loadedSessions: {},
      sessionRuntimeGraph: { endpoints: [] },
      sessionRuntimeCatalog: {
        status: 'loading',
        error: null,
        endpoints: [],
        defaultSessionPromptScope: null,
      },
    } as never));

    render(
      <MemoryRouter>
        <Chat isActive={false} />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('chat-offline')).toHaveAttribute('data-tone', 'loading');
    expect(screen.getByTestId('chat-offline-title')).toHaveTextContent('runtimePreparing.title');
    expect(screen.getByTestId('chat-offline-description')).toHaveTextContent('runtimePreparing.description');
  });

  it('当前会话仍在发送但没有会话错误时，不从 Host lifecycle 推导 transport 错误 banner', () => {
    useRuntimeHostStore.setState({
      runtimeHost: { lifecycle: 'running' },
    } as never);
    useChatStore.setState((state) => ({
      loadedSessions: {
        ...state.loadedSessions,
        'agent:main:main': buildSessionRecord({
          sessionKey: 'agent:main:main',
          runtime: {
            ...state.loadedSessions['agent:main:main']!.runtime,
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

    expect(screen.queryByTestId('chat-error-banner')).not.toBeInTheDocument();
  });

  it('当前会话仍在发送且只有 gateway 错误文本时，不应立即闪现错误 banner', () => {
    useRuntimeHostStore.setState({
      runtimeHost: { lifecycle: 'running' },
    } as never);
    useChatStore.setState((state) => ({
      loadedSessions: {
        ...state.loadedSessions,
        'agent:main:main': buildSessionRecord({
          sessionKey: 'agent:main:main',
          runtime: {
            ...state.loadedSessions['agent:main:main']!.runtime,
            runPhase: 'submitted',
            lastError: null,
            lastIssue: null,
          },
        }),
      },
    }));

    render(
      <MemoryRouter>
        <Chat isActive={false} />
      </MemoryRouter>,
    );

    expect(screen.queryByTestId('chat-error-banner')).not.toBeInTheDocument();
  });

  it('当前会话 runtime.lastIssue 的错误码应优先映射为本地化文案 key', () => {
    useChatStore.setState((state) => ({
      loadedSessions: {
        ...state.loadedSessions,
        'agent:main:main': buildSessionRecord({
          sessionKey: 'agent:main:main',
          runtime: {
            ...state.loadedSessions['agent:main:main']!.runtime,
            runPhase: 'error',
            lastError: null,
            lastIssue: {
              message: 'model unavailable',
              source: 'runtime',
              at: 1,
              code: 'MODEL_UNAVAILABLE',
              details: { provider: 'anthropic' },
            },
            updatedAt: 2,
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

  it('忽略后，同一次 runtime 错误快照再次灌回时不应重新显示', () => {
    useChatStore.setState((state) => ({
      loadedSessions: {
        ...state.loadedSessions,
        'agent:main:main': buildSessionRecord({
          sessionKey: 'agent:main:main',
          runtime: {
            ...state.loadedSessions['agent:main:main']!.runtime,
            runPhase: 'error',
            lastError: 'model unavailable',
            updatedAt: 2,
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

    fireEvent.click(screen.getByRole('button', { name: 'dismiss' }));
    expect(screen.queryByTestId('chat-error-banner')).toBeNull();

    act(() => {
      useChatStore.setState((state) => ({
        loadedSessions: {
          ...state.loadedSessions,
          'agent:main:main': buildSessionRecord({
            sessionKey: 'agent:main:main',
            runtime: {
              ...state.loadedSessions['agent:main:main']!.runtime,
              runPhase: 'error',
              lastError: 'model unavailable',
              updatedAt: 2,
            },
          }),
        },
      }));
    });

    expect(screen.queryByTestId('chat-error-banner')).toBeNull();
  });

  it('新的 runtime 错误实例到来时，即使上一次已忽略也应重新显示', () => {
    useChatStore.setState((state) => ({
      loadedSessions: {
        ...state.loadedSessions,
        'agent:main:main': buildSessionRecord({
          sessionKey: 'agent:main:main',
          runtime: {
            ...state.loadedSessions['agent:main:main']!.runtime,
            runPhase: 'error',
            lastError: 'old model unavailable',
            updatedAt: 2,
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

    fireEvent.click(screen.getByRole('button', { name: 'dismiss' }));
    expect(screen.queryByTestId('chat-error-banner')).toBeNull();

    act(() => {
      useChatStore.setState((state) => ({
        loadedSessions: {
          ...state.loadedSessions,
          'agent:main:main': buildSessionRecord({
            sessionKey: 'agent:main:main',
            runtime: {
              ...state.loadedSessions['agent:main:main']!.runtime,
              runPhase: 'error',
              lastError: 'new model unavailable',
              updatedAt: 3,
            },
          }),
        },
      }));
    });

    expect(screen.getByTestId('chat-error-banner')).toHaveTextContent('new model unavailable');
  });
});
