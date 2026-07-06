import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { forwardRef, type ReactNode, useImperativeHandle } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Chat from '@/pages/Chat';
import { useChatStore as realUseChatStore } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import { useSubagentsStore } from '@/stores/subagents';
import { useTeamsStore } from '@/stores/teams';
import { createEmptySessionRecord } from '@/stores/chat/store-state-helpers';
import { createViewportWindowState } from '@/stores/chat/viewport-state';
import { buildRenderItemsFromMessages } from './helpers/timeline-fixtures';
import { createOpenClawTestSessionIdentity, openClawTestRuntimeEndpoint } from './helpers/runtime-address-fixtures';

const chatViewportPaneRenderSpy = vi.fn();
const chatInputSendResultSpy = vi.fn();
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
            stagedPath: '/tmp/brief.txt',
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

function buildTeamRoleBinding(input: { runId: string; roleId: string; agentId: string; localSessionId: string; endpointSessionId?: string }) {
  return {
    runId: input.runId,
    roleId: input.roleId,
    agentId: input.agentId,
    endpointRef: openClawTestRuntimeEndpoint,
    localSessionId: input.localSessionId,
    endpointSessionId: input.endpointSessionId ?? `endpoint:${input.runId}:${input.roleId}`,
    sessionIdentity: createOpenClawTestSessionIdentity(input.localSessionId, input.agentId),
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
      backendSessionKey: sessionKey,
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
      submitTeamRoleMessageFromChat: vi.fn().mockResolvedValue(undefined),
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
            updatedAt: null,
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
      clearError: realUseChatStore.getState().clearError,
      resolveApproval: vi.fn().mockResolvedValue(undefined),
      refresh: vi.fn().mockResolvedValue(undefined),
      toggleThinking: vi.fn(),
    } as never);
  });

  it('Team role 会话发送时提交当前 session identity 对应 run 的 Team role chat message，不走普通 Agent chat send', async () => {
    const leaderBinding = buildTeamRoleBinding({ runId: 'run-1', roleId: 'leader', agentId: 'leader-agent', localSessionId: 'team-role-session-run-1-leader' });
    const leaderIdentity = leaderBinding.sessionIdentity;
    const submitTeamRoleMessageFromChat = vi.fn().mockResolvedValue(undefined);
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    useTeamsStore.setState({
      teams: [{
        id: 'team-1',
        name: 'Team 1',
        teamSkillName: 'team-skill',
        teamSkillVersion: '1.0.0',
        teamSkillDescription: 'Team skill',
        packagePath: '.tmp/team-skill',
        sourcePath: '.tmp/team-skill/SKILL.md',
        activeRunId: 'run-2',
        createdAt: 1,
        updatedAt: 1,
      }],
      runListByTeamId: {
        'team-1': [{
          runId: 'run-1',
          packageName: 'team-skill',
          packageVersion: '1.0.0',
          sourcePath: '.tmp/team-skill',
          status: 'running',
          revision: 1,
          createdAt: 1,
          updatedAt: 1,
          sessions: [leaderBinding],
        }, {
          runId: 'run-2',
          packageName: 'team-skill',
          packageVersion: '1.0.0',
          sourcePath: '.tmp/team-skill',
          status: 'running',
          revision: 2,
          createdAt: 2,
          updatedAt: 2,
          sessions: [],
        }],
      },
      submitTeamRoleMessageFromChat,
    } as never);
    useChatStore.setState((state) => ({
      currentSessionKey: leaderBinding.localSessionId,
      loadedSessions: {
        ...state.loadedSessions,
        [leaderBinding.localSessionId]: buildSessionRecord({
          sessionKey: leaderBinding.localSessionId,
          meta: { sessionIdentity: leaderIdentity, agentId: 'leader-agent' },
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

    await waitFor(() => expect(submitTeamRoleMessageFromChat).toHaveBeenCalledWith('team-1', 'leader', 'hello from test', 'run-1'));
    await waitFor(() => expect(chatInputSendResultSpy).toHaveBeenCalledWith({ accepted: true }));
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('Team role binding 尚未恢复时拒绝发送，不 fallback 到普通 Agent chat', async () => {
    const sessionKey = 'team-role-session-run-1-leader';
    const leaderIdentity = createOpenClawTestSessionIdentity(sessionKey, 'leader-agent');
    const submitTeamRoleMessageFromChat = vi.fn().mockResolvedValue(undefined);
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    useTeamsStore.setState({
      teams: [{
        id: 'team-1',
        name: 'Team 1',
        teamSkillName: 'team-skill',
        teamSkillVersion: '1.0.0',
        teamSkillDescription: 'Team skill',
        packagePath: '.tmp/team-skill',
        sourcePath: '.tmp/team-skill/SKILL.md',
        activeRunId: 'run-1',
        createdAt: 1,
        updatedAt: 1,
      }],
      runListByTeamId: { 'team-1': [] },
      rolesByTeamId: { 'team-1': [] },
      submitTeamRoleMessageFromChat,
    } as never);
    useChatStore.setState((state) => ({
      currentSessionKey: sessionKey,
      loadedSessions: {
        ...state.loadedSessions,
        [sessionKey]: buildSessionRecord({
          sessionKey,
          meta: { backendSessionKey: sessionKey, sessionIdentity: leaderIdentity, agentId: 'leader-agent' },
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

    await waitFor(() => expect(chatInputSendResultSpy).toHaveBeenCalledWith({
      accepted: false,
      reason: 'error',
      error: 'Team role session is not ready yet.',
    }));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(submitTeamRoleMessageFromChat).not.toHaveBeenCalled();
  });

  it('Team role 会话带附件时明确拒绝，不 fallback 到普通 Agent chat', async () => {
    const leaderBinding = buildTeamRoleBinding({ runId: 'run-1', roleId: 'leader', agentId: 'leader-agent', localSessionId: 'team-role-session-run-1-leader' });
    const leaderIdentity = leaderBinding.sessionIdentity;
    const submitTeamRoleMessageFromChat = vi.fn().mockResolvedValue(undefined);
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    useTeamsStore.setState({
      teams: [{
        id: 'team-1',
        name: 'Team 1',
        teamSkillName: 'team-skill',
        teamSkillVersion: '1.0.0',
        teamSkillDescription: 'Team skill',
        packagePath: '.tmp/team-skill',
        sourcePath: '.tmp/team-skill/SKILL.md',
        activeRunId: 'run-1',
        createdAt: 1,
        updatedAt: 1,
      }],
      runListByTeamId: {
        'team-1': [{
          runId: 'run-1',
          packageName: 'team-skill',
          packageVersion: '1.0.0',
          sourcePath: '.tmp/team-skill',
          status: 'running',
          revision: 1,
          createdAt: 1,
          updatedAt: 1,
          sessions: [leaderBinding],
        }],
      },
      submitTeamRoleMessageFromChat,
    } as never);
    useChatStore.setState((state) => ({
      currentSessionKey: leaderBinding.localSessionId,
      loadedSessions: {
        ...state.loadedSessions,
        [leaderBinding.localSessionId]: buildSessionRecord({
          sessionKey: leaderBinding.localSessionId,
          meta: { sessionIdentity: leaderIdentity, agentId: 'leader-agent' },
        }),
      },
      sendMessage,
    } as never));

    render(
      <MemoryRouter>
        <Chat isActive={false} />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByTestId('chat-input-with-attachment'));

    await waitFor(() => expect(chatInputSendResultSpy).toHaveBeenCalledWith({
      accepted: false,
      reason: 'error',
      error: 'Team role chat does not support attachments yet.',
    }));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(submitTeamRoleMessageFromChat).not.toHaveBeenCalled();
  });

  it('Team role 正在执行 node prompt 时仍提交普通 Team role message', async () => {
    const leaderBinding = buildTeamRoleBinding({ runId: 'run-1', roleId: 'leader', agentId: 'leader-agent', localSessionId: 'team-role-session-run-1-leader' });
    const leaderIdentity = leaderBinding.sessionIdentity;
    const submitTeamRoleMessageFromChat = vi.fn().mockResolvedValue(undefined);
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    useTeamsStore.setState({
      teams: [{
        id: 'team-1',
        name: 'Team 1',
        teamSkillName: 'team-skill',
        teamSkillVersion: '1.0.0',
        teamSkillDescription: 'Team skill',
        packagePath: '.tmp/team-skill',
        sourcePath: '.tmp/team-skill/SKILL.md',
        activeRunId: 'run-1',
        createdAt: 1,
        updatedAt: 1,
      }],
      runListByTeamId: {
        'team-1': [{
          runId: 'run-1',
          packageName: 'team-skill',
          packageVersion: '1.0.0',
          sourcePath: '.tmp/team-skill',
          status: 'running',
          revision: 1,
          createdAt: 1,
          updatedAt: 1,
          sessions: [leaderBinding],
        }],
      },
      nodeExecutionsByTeamId: {
        'team-1': [{ runId: 'run-1', nodeId: 'leader-plan', nodeExecutionId: 'node-exec-1', roleId: 'leader', status: 'running' }],
      },
      nodePromptDeliveryAttemptsByTeamId: {
        'team-1': [{
          deliveryRecordId: 'delivery-1',
          runId: 'run-1',
          nodeId: 'leader-plan',
          nodeExecutionId: 'node-exec-1',
          taskId: 'leader-plan',
          roleId: 'leader',
          toAgentId: 'leader-agent',
          localSessionId: leaderBinding.localSessionId,
          kind: 'node.prompt',
          title: 'Plan',
          prompt: 'Plan',
          status: 'delivered',
          idempotencyKey: 'delivery-1',
          causationId: 'trigger-1',
          createdAt: 1,
        }],
      },
      submitTeamRoleMessageFromChat,
    } as never);
    useChatStore.setState((state) => ({
      currentSessionKey: leaderBinding.localSessionId,
      loadedSessions: {
        ...state.loadedSessions,
        [leaderBinding.localSessionId]: buildSessionRecord({
          sessionKey: leaderBinding.localSessionId,
          meta: { sessionIdentity: leaderIdentity, agentId: 'leader-agent' },
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

    await waitFor(() => expect(submitTeamRoleMessageFromChat).toHaveBeenCalledWith('team-1', 'leader', 'hello from test', 'run-1'));
    await waitFor(() => expect(chatInputSendResultSpy).toHaveBeenCalledWith({ accepted: true }));
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('Team 会话发送不等待 TeamRun 提交完成即可 accepted', async () => {
    const leaderBinding = buildTeamRoleBinding({ runId: 'run-1', roleId: 'leader', agentId: 'leader-agent', localSessionId: 'team-role-session-run-1-leader' });
    const leaderIdentity = leaderBinding.sessionIdentity;
    let releaseSubmit!: () => void;
    const submitTeamRoleMessageFromChat = vi.fn().mockReturnValue(new Promise<void>((resolve) => {
      releaseSubmit = resolve;
    }));
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    useTeamsStore.setState({
      teams: [{
        id: 'team-1',
        name: 'Team 1',
        teamSkillName: 'team-skill',
        teamSkillVersion: '1.0.0',
        teamSkillDescription: 'Team skill',
        packagePath: '.tmp/team-skill',
        sourcePath: '.tmp/team-skill/SKILL.md',
        activeRunId: 'run-1',
        createdAt: 1,
        updatedAt: 1,
      }],
      runListByTeamId: {
        'team-1': [{
          runId: 'run-1',
          packageName: 'team-skill',
          packageVersion: '1.0.0',
          sourcePath: '.tmp/team-skill',
          status: 'running',
          revision: 1,
          createdAt: 1,
          updatedAt: 1,
          sessions: [leaderBinding],
        }],
      },
      submitTeamRoleMessageFromChat,
    } as never);
    useChatStore.setState((state) => ({
      currentSessionKey: leaderBinding.localSessionId,
      loadedSessions: {
        ...state.loadedSessions,
        [leaderBinding.localSessionId]: buildSessionRecord({
          sessionKey: leaderBinding.localSessionId,
          meta: { sessionIdentity: leaderIdentity, agentId: 'leader-agent' },
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

    await waitFor(() => expect(submitTeamRoleMessageFromChat).toHaveBeenCalledWith('team-1', 'leader', 'hello from test', 'run-1'));
    await waitFor(() => expect(chatInputSendResultSpy).toHaveBeenCalledWith({ accepted: true }));
    expect(sendMessage).not.toHaveBeenCalled();

    releaseSubmit();
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
    expect(useTeamsStore.getState().submitTeamRoleMessageFromChat).not.toHaveBeenCalled();
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

  it('运行期 gateway 恢复中应保留 Chat 内容并禁用输入框', () => {
    render(
      <MemoryRouter>
        <Chat isActive={false} />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('chat-shell')).toBeInTheDocument();
    expect(screen.getByTestId('chat-input')).toHaveAttribute('data-disabled', 'false');

    act(() => {
      useGatewayStore.setState({
        isInitialized: true,
        status: {
          processState: 'running',
          port: 18789,
          gatewayReady: false,
          healthSummary: 'unresponsive',
          transportState: 'disconnected',
          portReachable: true,
          lastError: 'Gateway RPC timeout: agents.list',
          lastIssue: {
            message: 'Gateway RPC timeout: agents.list',
            source: 'rpc',
            at: 2,
          },
          diagnostics: {
            consecutiveHeartbeatMisses: 0,
            consecutiveRpcFailures: 3,
          },
          updatedAt: 2,
        },
      } as never);
    });

    expect(screen.queryByTestId('chat-offline')).not.toBeInTheDocument();
    expect(screen.getByTestId('chat-shell')).toBeInTheDocument();
    expect(screen.getByTestId('chat-viewport-pane')).toHaveTextContent('1');
    expect(screen.getByTestId('chat-input')).toHaveAttribute('data-disabled', 'true');
    expect(screen.getByTestId('chat-input')).toHaveAttribute('data-reconnecting', 'true');
  });

  it('gateway 进程仍在恢复时，socket 1006 不应显示为断连错误', () => {
    useGatewayStore.setState({
      isInitialized: true,
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
    expect(screen.getByTestId('chat-offline')).toHaveAttribute('data-tone', 'loading');
    expect(screen.getByTestId('chat-offline-title')).toHaveTextContent('gatewayPreparing.title');
    expect(screen.getByTestId('chat-offline-description')).toHaveTextContent('gatewayPreparing.description');
  });

  it('gateway 进程停止后，离线页应显示具体 transport 错误原因', () => {
    useGatewayStore.setState({
      isInitialized: true,
      status: {
        processState: 'stopped',
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
    expect(screen.getByTestId('chat-offline')).toHaveAttribute('data-tone', 'error');
    expect(screen.getByTestId('chat-offline-description')).toHaveTextContent('errors.gatewaySocketClosed');
  });

  it('应用刚启动、gateway 状态尚未初始化时，应显示准备中而不是断连错误', () => {
    useGatewayStore.setState({
      isInitialized: false,
      status: {
        processState: 'stopped',
        port: 18789,
        gatewayReady: false,
        healthSummary: 'unresponsive',
        transportState: 'disconnected',
        portReachable: false,
        lastError: 'Gateway socket closed: code=1006 reason=unknown',
        diagnostics: {
          consecutiveHeartbeatMisses: 0,
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

    expect(screen.getByTestId('chat-offline')).toHaveAttribute('data-tone', 'loading');
    expect(screen.getByTestId('chat-offline-title')).toHaveTextContent('gatewayPreparing.title');
    expect(screen.getByTestId('chat-offline-description')).toHaveTextContent('gatewayPreparing.description');
  });

  it('当前会话仍在发送时，应延迟显示 gateway transport issue banner', async () => {
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
    await waitFor(() => {
      expect(screen.getByTestId('chat-error-banner')).toHaveTextContent('errors.gatewayRpcTimeout');
    });
  });

  it('当前会话仍在发送且只有 gateway 错误文本时，不应立即闪现错误 banner', () => {
    useGatewayStore.setState({
      status: {
        processState: 'running',
        port: 18789,
        gatewayReady: true,
        healthSummary: 'degraded',
        transportState: 'connected',
        portReachable: true,
        lastError: 'Gateway RPC timeout: chat.send',
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
