import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AgentSessionsPane } from '@/components/layout/AgentSessionsPane';
import { useChatStore } from '@/stores/chat';
import { useRuntimeHostStore } from '@/stores/gateway';
import { useSubagentsStore } from '@/stores/subagents';
import { useTeamsStore } from '@/stores/teams';
import i18n from '@/i18n';
import { createEmptySessionRecord } from '@/stores/chat/store-state-helpers';
import { buildRenderItemsFromMessages } from './helpers/timeline-fixtures';
import type { RawMessage } from './helpers/timeline-fixtures';
import { createViewportWindowState } from '@/stores/chat/viewport-state';
import {
  buildCurrentConversationFromSessionRecord,
  buildSessionRuntimeGraph,
} from '@/stores/chat/session-runtime-graph';
import {
  buildRuntimeEndpointKey,
  buildSessionIdentityKey,
  type AgentScope,
  type RuntimeEndpointRef,
  type SessionIdentity,
} from '../../src/types/desktop/runtime-address';
import type { SessionOwnership } from '../../src/types/desktop/session-ownership';
import {
  createOpenClawTestSessionIdentity,
  openClawTestRuntimeEndpoint,
  openClawTestRuntimeIdentity,
} from './helpers/runtime-address-fixtures';

const readyResource = {
  status: 'ready' as const,
  error: null,
  hasLoadedOnce: true,
  lastLoadedAt: 1,
};

const matchaAgentTestRuntimeEndpoint: RuntimeEndpointRef = {
  kind: 'native-runtime',
  runtimeAdapterId: 'matcha-agent',
  runtimeInstanceId: 'default',
};

function createAgentScope(endpoint: RuntimeEndpointRef, agentId: string): AgentScope {
  return {
    kind: 'agent',
    endpoint,
    agentId,
  };
}

const openClawMainScope = createAgentScope(openClawTestRuntimeEndpoint, 'main');
const openClawDefaultScope = createAgentScope(openClawTestRuntimeEndpoint, 'default');
const openClawTestScope = createAgentScope(openClawTestRuntimeEndpoint, 'test');
const matchaAgentMatchaScope = createAgentScope(matchaAgentTestRuntimeEndpoint, 'matcha');

function buildReadySessionRuntimeCatalog() {
  return {
    status: 'ready' as const,
    error: null,
    endpoints: [
      {
        endpointId: openClawTestRuntimeIdentity.runtimeEndpointId,
        protocolId: openClawTestRuntimeIdentity.protocolId,
        endpoint: openClawTestRuntimeEndpoint,
        runtimeAdapterId: openClawTestRuntimeEndpoint.kind === 'native-runtime' ? openClawTestRuntimeEndpoint.runtimeAdapterId : undefined,
        runtimeInstanceId: openClawTestRuntimeEndpoint.kind === 'native-runtime' ? openClawTestRuntimeEndpoint.runtimeInstanceId : undefined,
        displayName: 'OpenClaw',
        agentIds: ['main', 'test'],
        acceptsDynamicAgents: true,
        agentCatalog: {
          source: 'subagent-management' as const,
          seedAgents: [{ id: 'main', name: 'main' }, { id: 'test', name: 'test' }],
        },
        sessionPromptScopes: [openClawMainScope, openClawTestScope],
        defaultSessionPromptScope: openClawMainScope,
      },
      {
        endpointId: 'matcha-agent-default',
        protocolId: 'matcha-agent',
        endpoint: matchaAgentTestRuntimeEndpoint,
        runtimeAdapterId: matchaAgentTestRuntimeEndpoint.kind === 'native-runtime' ? matchaAgentTestRuntimeEndpoint.runtimeAdapterId : undefined,
        runtimeInstanceId: matchaAgentTestRuntimeEndpoint.kind === 'native-runtime' ? matchaAgentTestRuntimeEndpoint.runtimeInstanceId : undefined,
        displayName: 'Matcha Agent',
        agentIds: ['matcha'],
        acceptsDynamicAgents: false,
        agentCatalog: {
          source: 'runtime-endpoint' as const,
          agents: [{ id: 'matcha', name: 'matcha' }],
        },
        sessionPromptScopes: [matchaAgentMatchaScope],
        defaultSessionPromptScope: matchaAgentMatchaScope,
      },
    ],
    defaultSessionPromptScope: openClawMainScope,
  };
}

function buildReadySessionCatalogStatus(_sessions: Array<{ key: string; displayName: string }>) {
  return {
    ...readyResource,
  };
}

function readAgentIdFromSessionKey(sessionKey: string): string {
  return sessionKey.split(':')[1] || 'default';
}

function createSessionIdentity(sessionKey: string, agentId = readAgentIdFromSessionKey(sessionKey)): SessionIdentity {
  return createOpenClawTestSessionIdentity(sessionKey, agentId);
}

function createMatchaAgentSessionIdentity(sessionKey = 'agent:matcha:main'): SessionIdentity {
  return {
    endpoint: matchaAgentTestRuntimeEndpoint,
    agentId: 'matcha',
    sessionKey,
  };
}

function recordKeyForSession(sessionKey: string, identity = createSessionIdentity(sessionKey)): string {
  return buildSessionIdentityKey(identity);
}

function createSessionRecord(input?: {
  sessionKey?: string;
  agentId?: string | null;
  sessionIdentity?: SessionIdentity;
  ownership?: SessionOwnership | null;
  messages?: RawMessage[];
  label?: string | null;
  displayName?: string | null;
  lastActivityAt?: number | null;
  historyStatus?: 'idle' | 'loading' | 'ready' | 'error';
}) {
  const sessionKey = input?.sessionKey ?? 'agent:test:session-1';
  const sessionIdentity = input?.sessionIdentity ?? createSessionIdentity(sessionKey, input?.agentId ?? undefined);
  const messages = input?.messages ?? [];
  const base = createEmptySessionRecord();
  return {
    meta: {
      ...base.meta,
      runtimeScopeKey: buildRuntimeEndpointKey(sessionIdentity.endpoint),
      agentId: input?.agentId === undefined ? sessionIdentity.agentId : input.agentId,
      protocolId: null,
      runtimeEndpointId: 'local',
      sessionIdentity,
      ownership: input?.ownership === undefined ? { kind: 'ordinary' } : input.ownership,
      kind: sessionKey.endsWith(':main') ? 'main' : 'session',
      preferred: sessionKey.endsWith(':main'),
      label: input?.label ?? null,
      titleSource: input?.label ? 'user' : 'none',
      displayName: input?.displayName ?? null,
      lastActivityAt: input?.lastActivityAt ?? null,
      historyStatus: input?.historyStatus ?? 'idle',
    },
    runtime: {
      ...base.runtime,
    },
    items: buildRenderItemsFromMessages(sessionKey, messages),
    window: createViewportWindowState({
      totalItemCount: messages.length,
      windowStartOffset: 0,
      windowEndOffset: messages.length,
      isAtLatest: true,
    }),
  };
}

function syncChatSessionRuntimeState(): void {
  const state = useChatStore.getState();
  const sessionRuntimeGraph = buildSessionRuntimeGraph(state.sessionRuntimeCatalog, state.loadedSessions);
  const currentRecord = state.currentSessionKey ? state.loadedSessions[state.currentSessionKey] : null;
  useChatStore.setState({
    sessionRuntimeGraph,
    currentConversation: currentRecord ? buildCurrentConversationFromSessionRecord(currentRecord) : null,
  } as never);
}

function setupBaseState() {
  useTeamsStore.setState({
    teams: [],
    activeTeamId: null,
    runIdsByTeamId: {},
    runListByTeamId: {},
    runsById: {},
    runByTeamId: {},
    rolesByTeamId: {},
    setActiveRun: vi.fn(),
    syncRunList: vi.fn().mockResolvedValue(undefined),
    refreshSnapshot: vi.fn().mockResolvedValue(undefined),
  } as never);

  useRuntimeHostStore.setState({
    runtimeHost: { lifecycle: 'running' },
    init: vi.fn().mockResolvedValue(undefined),
  } as never);

  useSubagentsStore.setState({
    agents: [
      { id: 'main', name: 'main', isDefault: true, avatarSeed: 'agent:main', avatarStyle: 'pixelArt' },
      { id: 'test', name: 'test', isDefault: false, avatarSeed: 'agent:test', avatarStyle: 'bottts' },
    ],
    agentsResource: readyResource,
    loadAgents: vi.fn().mockResolvedValue(undefined),
  } as never);
  useChatStore.setState({
    currentSessionKey: '',
    loadedSessions: {},
    currentConversation: null,
    sessionRuntimeGraph: { endpoints: [] },
    sessionCatalogStatus: readyResource,
    sessionRuntimeCatalog: buildReadySessionRuntimeCatalog(),
  } as never);
  syncChatSessionRuntimeState();
}

function renderPane(options: { open?: boolean; tab?: 'agent' | 'team' | 'session' } = {}) {
  syncChatSessionRuntimeState();
  render(
    <MemoryRouter>
      <AgentSessionsPane />
    </MemoryRouter>,
  );
  if (options.open === false) {
    return;
  }
  fireEvent.click(screen.getByTestId('agent-session-identity-beacon'));
  if (options.tab === 'team') {
    fireEvent.click(screen.getByRole('button', { name: 'Teams' }));
  }
  if (options.tab === 'session') {
    fireEvent.click(screen.getByRole('button', { name: 'Sessions' }));
  }
}

describe('agent sessions pane', () => {
  beforeEach(() => {
    window.localStorage.clear();
    i18n.changeLanguage('en');
    setupBaseState();
  });

  it('在 team tab 展示 Team → Run → leader/roles，点击 run 后选择并刷新公开图和审批视图', async () => {
    const leaderIdentity = createSessionIdentity('agent:leader-agent:main', 'leader-agent');
    const roleIdentity = createSessionIdentity('agent:designer-agent:main', 'designer-agent');
    const setActiveRun = vi.fn();
    const createRun = vi.fn().mockResolvedValue(undefined);
    const syncRunList = vi.fn().mockResolvedValue(undefined);
    const refreshSnapshot = vi.fn().mockResolvedValue(undefined);
    const switchSession = vi.fn();
    const openSessionIdentity = vi.fn();
    useChatStore.setState({
      switchSession,
      openSessionIdentity,
      loadedSessions: {
        [recordKeyForSession('agent:leader-agent:main', leaderIdentity)]: createSessionRecord({ sessionKey: 'agent:leader-agent:main', sessionIdentity: leaderIdentity, historyStatus: 'ready' }),
        [recordKeyForSession('agent:designer-agent:main', roleIdentity)]: createSessionRecord({ sessionKey: 'agent:designer-agent:main', sessionIdentity: roleIdentity, historyStatus: 'ready' }),
      },
    } as never);
    syncChatSessionRuntimeState();
    useTeamsStore.setState({
      teams: [
        {
          id: 'team-1',
          name: 'Team One',
          teamSkillName: 'team-skill',
          teamSkillVersion: '1.0.0',
          teamSkillDescription: 'Team skill',
          packagePath: '.tmp/team-skill',
          sourcePath: '.tmp/team-skill/SKILL.md',
          activeRunId: 'teamrun-new',
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      runIdsByTeamId: { 'team-1': ['teamrun-old', 'teamrun-new'] },
      runListByTeamId: {
        'team-1': [
          {
            runId: 'teamrun-old',
            packageName: 'team-skill',
            packageVersion: '1.0.0',
            sourcePath: '.tmp/team-skill/SKILL.md',
            status: 'completed',
            currentStageId: 'stage-old',
            revision: 1,
            createdAt: 1,
            updatedAt: 1,
          },
          {
            runId: 'teamrun-new',
            packageName: 'team-skill',
            packageVersion: '1.0.0',
            sourcePath: '.tmp/team-skill/SKILL.md',
            status: 'running',
            currentStageId: 'stage-new',
            revision: 2,
            createdAt: 2,
            updatedAt: 3,
            sessions: [
              {
                roleId: 'leader',
                agentId: 'leader-agent',
                sessionIdentity: leaderIdentity,
                localSessionId: 'agent:leader-agent:main',
                endpointSessionId: 'main',
              },
              {
                roleId: 'designer',
                agentId: 'designer-agent',
                sessionIdentity: roleIdentity,
                localSessionId: 'agent:designer-agent:main',
                endpointSessionId: 'main',
              },
            ],
          },
        ],
      },
      setActiveRun,
      createRun,
      syncRunList,
      refreshSnapshot,
    } as never);

    renderPane({ tab: 'team' });

    await waitFor(() => {
      expect(syncRunList).toHaveBeenCalledWith('team-1');
    });
    fireEvent.click(screen.getByRole('button', { name: /New Run Team One/i }));
    expect(createRun).toHaveBeenCalledWith('team-1');

    fireEvent.click(screen.getByRole('button', { name: /^Team One$/i }));
    expect(screen.getByRole('button', { name: /teamrun-new/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /teamrun-old/i })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /teamrun-old/i }));
    expect(setActiveRun).toHaveBeenCalledWith('team-1', 'teamrun-old');
    expect(switchSession).not.toHaveBeenCalled();
    expect(refreshSnapshot).toHaveBeenCalledWith('team-1', { force: true });
    expect(screen.queryByTestId('chat-switchboard')).toBeNull();

    fireEvent.click(screen.getByTestId('agent-session-identity-beacon'));
    const newRunButton = screen.getByRole('button', { name: /teamrun-new/i });
    fireEvent.click(newRunButton.previousElementSibling as HTMLElement);
    expect(screen.getByRole('button', { name: /Leader/i })).toBeTruthy();
    const designerRoleButton = screen.getByRole('button', { name: /designer/i });
    expect(designerRoleButton).toBeTruthy();

    setActiveRun.mockClear();
    switchSession.mockClear();
    openSessionIdentity.mockClear();
    refreshSnapshot.mockClear();
    fireEvent.click(designerRoleButton);
    expect(setActiveRun).toHaveBeenCalledWith('team-1', 'teamrun-new');
    expect(openSessionIdentity).toHaveBeenCalledWith({
      sessionIdentity: roleIdentity,
      endpointSessionId: 'main',
    });
    expect(refreshSnapshot).toHaveBeenCalledWith('team-1', { force: true });
  });

  it('Agent 与会话历史在 Switchboard 中顶层分离', async () => {
    const now = Date.now();
    const sessions = [
      { key: 'agent:main:main', displayName: 'agent:main:main' },
      { key: 'agent:main:session-1', displayName: 'agent:main:session-1' },
      { key: 'agent:test:main', displayName: 'agent:test:main' },
      { key: 'agent:test:session-2', displayName: 'agent:test:session-2' },
    ];
    useChatStore.setState({
      currentSessionKey: recordKeyForSession('agent:main:main'),
      sessionCatalogStatus: buildReadySessionCatalogStatus(sessions),
      loadedSessions: {
        [recordKeyForSession('agent:main:main')]: createSessionRecord({ sessionKey: 'agent:main:main', historyStatus: 'ready' }),
        [recordKeyForSession('agent:main:session-1')]: createSessionRecord({ sessionKey: 'agent:main:session-1', historyStatus: 'ready', label: '主Agent会话', lastActivityAt: now - 1 * 24 * 60 * 60 * 1000 }),
        [recordKeyForSession('agent:test:main')]: createSessionRecord({ sessionKey: 'agent:test:main', historyStatus: 'ready' }),
        [recordKeyForSession('agent:test:session-2')]: createSessionRecord({ sessionKey: 'agent:test:session-2', historyStatus: 'ready', label: '测试Agent会话', lastActivityAt: now - 2 * 24 * 60 * 60 * 1000 }),
      },
      switchSession: vi.fn(),
      newSession: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);
    syncChatSessionRuntimeState();

    renderPane();

    expect(screen.getByTestId('agent-item-main')).toBeInTheDocument();
    expect(screen.getByTestId('agent-item-test')).toBeInTheDocument();
    expect(screen.getByTestId('agent-session-avatar-main')).toBeInTheDocument();
    expect(screen.getByTestId('agent-session-avatar-test')).toBeInTheDocument();
    expect(screen.queryByText('主Agent会话')).not.toBeInTheDocument();
    expect(screen.queryByText('测试Agent会话')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Sessions' }));

    expect(screen.getByText('主Agent会话')).toBeInTheDocument();
    expect(screen.getByText('测试Agent会话')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-item-main')).not.toBeInTheDocument();
  });

  it('点击 agent 时不把 automation 当作默认会话', () => {
    const now = Date.now();
    const ordinaryIdentity = createSessionIdentity('agent:test:session-ordinary', 'test');
    const automationIdentity = createSessionIdentity('agent:test:cron:daily', 'test');
    const ordinaryKey = recordKeyForSession('agent:test:session-ordinary', ordinaryIdentity);
    const automationKey = recordKeyForSession('agent:test:cron:daily', automationIdentity);
    const switchSession = vi.fn();
    useChatStore.setState({
      currentSessionKey: '',
      loadedSessions: {
        [ordinaryKey]: createSessionRecord({
          sessionKey: 'agent:test:session-ordinary',
          sessionIdentity: ordinaryIdentity,
          historyStatus: 'ready',
          label: '普通 Agent 历史会话',
          lastActivityAt: now - 60_000,
        }),
        [automationKey]: {
          ...createSessionRecord({
            sessionKey: 'agent:test:cron:daily',
            sessionIdentity: automationIdentity,
            historyStatus: 'ready',
            label: '自动化运行结果',
            lastActivityAt: now,
          }),
          meta: {
            ...createSessionRecord({
              sessionKey: 'agent:test:cron:daily',
              sessionIdentity: automationIdentity,
            }).meta,
            kind: 'automation' as never,
            label: '自动化运行结果',
            historyStatus: 'ready',
            lastActivityAt: now,
          },
        },
      },
      switchSession,
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);
    syncChatSessionRuntimeState();

    renderPane();
    fireEvent.click(screen.getByTestId('agent-item-test'));

    expect(switchSession).toHaveBeenCalledWith(ordinaryKey, null);
  });

  it('agent 只有 automation 会话时，点击 agent 进入可发送草稿态', () => {
    const now = Date.now();
    const automationIdentity = createSessionIdentity('agent:test:cron:daily', 'test');
    const automationKey = recordKeyForSession('agent:test:cron:daily', automationIdentity);
    const switchSession = vi.fn();
    useChatStore.setState({
      currentSessionKey: '',
      loadedSessions: {
        [automationKey]: {
          ...createSessionRecord({
            sessionKey: 'agent:test:cron:daily',
            sessionIdentity: automationIdentity,
            historyStatus: 'ready',
            label: '自动化运行结果',
            lastActivityAt: now,
          }),
          meta: {
            ...createSessionRecord({
              sessionKey: 'agent:test:cron:daily',
              sessionIdentity: automationIdentity,
            }).meta,
            kind: 'automation' as never,
            label: '自动化运行结果',
            historyStatus: 'ready',
            lastActivityAt: now,
          },
        },
      },
      switchSession,
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);
    syncChatSessionRuntimeState();

    renderPane();
    fireEvent.click(screen.getByTestId('agent-item-test'));

    expect(switchSession).not.toHaveBeenCalled();
    expect(useChatStore.getState().currentConversation).toMatchObject({
      kind: 'draft',
      agentId: 'test',
    });
  });

  it('会话 tab 不把 automation 混入普通列表，并在独立只读分区展示', () => {
    const now = Date.now();
    const ordinaryAgentIdentity = createSessionIdentity('agent:test:session-ordinary-agent', 'test');
    const automationIdentity = createSessionIdentity('agent:test:automation-run-1', 'test');
    const ordinaryKey = recordKeyForSession('agent:test:session-ordinary-agent', ordinaryAgentIdentity);
    const automationKey = recordKeyForSession('agent:test:automation-run-1', automationIdentity);
    useChatStore.setState({
      currentSessionKey: ordinaryKey,
      sessionCatalogStatus: buildReadySessionCatalogStatus([
        { key: 'agent:test:session-ordinary-agent', displayName: '普通 Agent 历史会话' },
        { key: 'agent:test:automation-run-1', displayName: '自动化运行结果' },
      ]),
      loadedSessions: {
        [ordinaryKey]: createSessionRecord({
          sessionKey: 'agent:test:session-ordinary-agent',
          sessionIdentity: ordinaryAgentIdentity,
          historyStatus: 'ready',
          label: '普通 Agent 历史会话',
          lastActivityAt: now,
        }),
        [automationKey]: {
          ...createSessionRecord({
            sessionKey: 'agent:test:automation-run-1',
            sessionIdentity: automationIdentity,
            historyStatus: 'ready',
            label: '自动化运行结果',
            lastActivityAt: now - 60_000,
          }),
          meta: {
            ...createSessionRecord({
              sessionKey: 'agent:test:automation-run-1',
              sessionIdentity: automationIdentity,
            }).meta,
            kind: 'automation' as never,
            label: '自动化运行结果',
            historyStatus: 'ready',
            lastActivityAt: now - 60_000,
          },
        },
      },
      switchSession: vi.fn(),
      newSession: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      renameSession: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);
    syncChatSessionRuntimeState();

    renderPane({ tab: 'session' });

    expect(screen.getByRole('tab', { name: /Normal 1/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /Automation 1/i })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByText('普通 Agent 历史会话')).toBeInTheDocument();
    expect(screen.queryByText('自动化运行结果')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /Automation 1/i }));

    expect(screen.getByRole('tab', { name: /Normal 1/i })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tab', { name: /Automation 1/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByText('普通 Agent 历史会话')).not.toBeInTheDocument();
    expect(screen.getByText('自动化运行结果')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete session .*自动化运行结果/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Rename session 自动化运行结果/i })).toBeNull();
  });

  it('当前会话是 automation 时，会话 tab 默认打开自动化页', () => {
    const now = Date.now();
    const ordinaryAgentIdentity = createSessionIdentity('agent:test:session-ordinary-agent', 'test');
    const automationIdentity = createSessionIdentity('agent:test:automation-run-1', 'test');
    const ordinaryKey = recordKeyForSession('agent:test:session-ordinary-agent', ordinaryAgentIdentity);
    const automationKey = recordKeyForSession('agent:test:automation-run-1', automationIdentity);
    useChatStore.setState({
      currentSessionKey: automationKey,
      sessionCatalogStatus: buildReadySessionCatalogStatus([
        { key: 'agent:test:session-ordinary-agent', displayName: '普通 Agent 历史会话' },
        { key: 'agent:test:automation-run-1', displayName: '自动化运行结果' },
      ]),
      loadedSessions: {
        [ordinaryKey]: createSessionRecord({
          sessionKey: 'agent:test:session-ordinary-agent',
          sessionIdentity: ordinaryAgentIdentity,
          historyStatus: 'ready',
          label: '普通 Agent 历史会话',
          lastActivityAt: now,
        }),
        [automationKey]: {
          ...createSessionRecord({
            sessionKey: 'agent:test:automation-run-1',
            sessionIdentity: automationIdentity,
            historyStatus: 'ready',
            label: '自动化运行结果',
            lastActivityAt: now - 60_000,
          }),
          meta: {
            ...createSessionRecord({
              sessionKey: 'agent:test:automation-run-1',
              sessionIdentity: automationIdentity,
            }).meta,
            kind: 'automation' as never,
            label: '自动化运行结果',
            historyStatus: 'ready',
            lastActivityAt: now - 60_000,
          },
        },
      },
      switchSession: vi.fn(),
      newSession: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      renameSession: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);
    syncChatSessionRuntimeState();

    renderPane({ tab: 'session' });

    expect(screen.getByRole('tab', { name: /Normal 1/i })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tab', { name: /Automation 1/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByText('普通 Agent 历史会话')).not.toBeInTheDocument();
    expect(screen.getByText('自动化运行结果')).toBeInTheDocument();
  });

  it('会话 tab 保留 Team role 记录但普通入口不显示', () => {
    const now = Date.now();
    const bindingRoleIdentity = createSessionIdentity('agent:test:session-canonical-binding-role', 'test');
    const runListRoleIdentity = createSessionIdentity('agent:test:session-canonical-run-list-role', 'test');
    const ordinaryAgentIdentity = createSessionIdentity('agent:test:session-ordinary-agent', 'test');
    useTeamsStore.setState({
      teams: [
        {
          id: 'team-1',
          name: 'Team One',
          teamSkillName: 'team-skill',
          teamSkillVersion: '1.0.0',
          teamSkillDescription: 'Team skill',
          packagePath: '.tmp/team-skill',
          sourcePath: '.tmp/team-skill/SKILL.md',
          activeRunId: 'teamrun-run-list',
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      rolesByTeamId: {
        'team-1': [
          {
            teamId: 'team-1',
            runId: 'teamrun-binding',
            roleId: 'researcher',
            agentId: 'test',
            localSessionId: 'agent:test:session-canonical-binding-role',
            endpointSessionId: 'agent:test:session-canonical-binding-role',
            sessionIdentity: bindingRoleIdentity,
          },
        ],
      },
      runListByTeamId: {
        'team-1': [{
          runId: 'teamrun-run-list',
          packageName: 'team-skill',
          packageVersion: '1.0.0',
          sourcePath: '.tmp/team-skill/SKILL.md',
          status: 'running',
          currentStageId: 'stage-new',
          revision: 1,
          createdAt: 1,
          updatedAt: 2,
          sessions: [
            {
              roleId: 'researcher',
              agentId: 'test',
              sessionIdentity: runListRoleIdentity,
              localSessionId: 'agent:test:session-canonical-run-list-role',
              endpointSessionId: 'agent:test:session-canonical-run-list-role',
            },
          ],
        }],
      },
      teamRoleSessionsByTeamId: {
        'team-1': [
          { teamId: 'team-1', runId: 'teamrun-binding', roleId: 'researcher', sessionRef: 'agent:test:session-canonical-binding-role', status: 'available' },
          { teamId: 'team-1', runId: 'teamrun-run-list', roleId: 'designer', sessionRef: 'agent:test:session-canonical-run-list-role', status: 'available' },
        ],
      },
    } as never);
    useChatStore.setState({
      currentSessionKey: recordKeyForSession('agent:test:session-ordinary-agent', ordinaryAgentIdentity),
      sessionCatalogStatus: buildReadySessionCatalogStatus([
        { key: 'agent:test:session-canonical-binding-role', displayName: 'Team binding role history' },
        { key: 'agent:test:session-canonical-run-list-role', displayName: 'Team run list role history' },
        { key: 'agent:test:session-ordinary-agent', displayName: '普通 Agent 历史会话' },
      ]),
      loadedSessions: {
        [recordKeyForSession('agent:test:session-canonical-binding-role', bindingRoleIdentity)]: createSessionRecord({
          sessionKey: 'agent:test:session-canonical-binding-role',
          sessionIdentity: bindingRoleIdentity,
          ownership: {
            kind: 'team',
            teamId: 'team-1',
            teamRunId: 'teamrun-binding',
            roleId: 'researcher',
            sessionRef: 'agent:test:session-canonical-binding-role',
          },
          historyStatus: 'ready',
          label: 'Team binding role history',
          lastActivityAt: now,
        }),
        [recordKeyForSession('agent:test:session-canonical-run-list-role', runListRoleIdentity)]: createSessionRecord({
          sessionKey: 'agent:test:session-canonical-run-list-role',
          sessionIdentity: runListRoleIdentity,
          ownership: {
            kind: 'team',
            teamId: 'team-1',
            teamRunId: 'teamrun-run-list',
            roleId: 'researcher',
            sessionRef: 'agent:test:session-canonical-run-list-role',
          },
          historyStatus: 'ready',
          label: 'Team run list role history',
          lastActivityAt: now - 60_000,
        }),
        [recordKeyForSession('agent:test:session-ordinary-agent', ordinaryAgentIdentity)]: createSessionRecord({
          sessionKey: 'agent:test:session-ordinary-agent',
          sessionIdentity: ordinaryAgentIdentity,
          historyStatus: 'ready',
          label: '普通 Agent 历史会话',
          lastActivityAt: now - 120_000,
        }),
      },
      switchSession: vi.fn(),
      newSession: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);
    syncChatSessionRuntimeState();

    renderPane({ tab: 'session' });

    expect(screen.queryByText('Team binding role history')).not.toBeInTheDocument();
    expect(screen.queryByText('Team run list role history')).not.toBeInTheDocument();
    expect(screen.getByText('普通 Agent 历史会话')).toBeInTheDocument();
    expect(useChatStore.getState().loadedSessions[recordKeyForSession('agent:test:session-canonical-binding-role', bindingRoleIdentity)]).toBeTruthy();
    expect(useChatStore.getState().loadedSessions[recordKeyForSession('agent:test:session-canonical-run-list-role', runListRoleIdentity)]).toBeTruthy();
  });

  it('ownership:null 的未知记录不当作普通历史', () => {
    const now = Date.now();
    const unknownIdentity = createSessionIdentity('agent:leader-agent:unknown-session', 'leader-agent');
    const ordinaryAgentIdentity = createSessionIdentity('agent:leader-agent:session-ordinary', 'leader-agent');
    useChatStore.setState({
      currentSessionKey: recordKeyForSession('agent:leader-agent:session-ordinary', ordinaryAgentIdentity),
      sessionCatalogStatus: buildReadySessionCatalogStatus([
        { key: 'agent:leader-agent:unknown-session', displayName: 'Unknown ownership history' },
        { key: 'agent:leader-agent:session-ordinary', displayName: '普通 Leader Agent 历史' },
      ]),
      loadedSessions: {
        [recordKeyForSession('agent:leader-agent:unknown-session', unknownIdentity)]: createSessionRecord({
          sessionKey: 'agent:leader-agent:unknown-session',
          sessionIdentity: unknownIdentity,
          ownership: null,
          historyStatus: 'ready',
          label: 'Unknown ownership history',
          lastActivityAt: now,
        }),
        [recordKeyForSession('agent:leader-agent:session-ordinary', ordinaryAgentIdentity)]: createSessionRecord({
          sessionKey: 'agent:leader-agent:session-ordinary',
          sessionIdentity: ordinaryAgentIdentity,
          historyStatus: 'ready',
          label: '普通 Leader Agent 历史',
          lastActivityAt: now - 60_000,
        }),
      },
      switchSession: vi.fn(),
      newSession: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);
    syncChatSessionRuntimeState();

    renderPane({ tab: 'session' });

    expect(screen.queryByText('Unknown ownership history')).not.toBeInTheDocument();
    expect(screen.getByText('普通 Leader Agent 历史')).toBeInTheDocument();
  });

  it('fixed runtime catalog 未就绪时禁用新会话入口', () => {
    useChatStore.setState({
      sessionRuntimeCatalog: {
        status: 'idle',
        error: null,
        endpoints: [],
        defaultSessionPromptScope: null,
      },
    } as never);

    renderPane({ open: false });

    expect(screen.getByTestId('agent-session-new-current')).toBeDisabled();
  });

  it('常态露出身份 Beacon 和头像下方裸加号，点击 Beacon 打开 Switchboard', () => {
    const newSessionForScope = vi.fn().mockResolvedValue(undefined);
    useChatStore.setState({
      currentSessionKey: recordKeyForSession('agent:test:main'),
      sessionCatalogStatus: buildReadySessionCatalogStatus([
        { key: 'agent:main:main', displayName: 'agent:main:main' },
        { key: 'agent:test:main', displayName: 'agent:test:main' },
      ]),
      loadedSessions: {
        [recordKeyForSession('agent:main:main')]: createSessionRecord({ sessionKey: 'agent:main:main', historyStatus: 'ready' }),
        [recordKeyForSession('agent:test:main')]: createSessionRecord({ sessionKey: 'agent:test:main', historyStatus: 'ready' }),
      },
      switchSession: vi.fn(),
      newSession: vi.fn(),
      newSessionForScope,
      deleteSession: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);
    syncChatSessionRuntimeState();

    renderPane({ open: false });

    expect(screen.getByTestId('agent-session-new-current')).toBeInTheDocument();
    expect(screen.getByTestId('agent-session-identity-beacon')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-session-runtime-selector')).toBeNull();
    expect(screen.queryByTestId('agent-list-scroll-area')).toBeNull();
    expect(screen.queryByTestId('session-list-scroll-area')).toBeNull();

    fireEvent.click(screen.getByTestId('agent-session-identity-beacon'));

    const switchboard = screen.getByTestId('chat-switchboard');
    expect(within(switchboard).getByRole('button', { name: 'Agents' })).toBeInTheDocument();
    expect(within(switchboard).getByRole('button', { name: 'Teams' })).toBeInTheDocument();
    expect(within(switchboard).getByRole('button', { name: 'Sessions' })).toBeInTheDocument();
  });

  it('点击某个 agent 的新会话按钮，应按选中 runtime 中对应 agent scope 创建', async () => {
    const newSessionForScope = vi.fn().mockResolvedValue(undefined);
    const sessions = [
      { key: 'agent:main:main', displayName: 'agent:main:main' },
      { key: 'agent:test:main', displayName: 'agent:test:main' },
    ];
    useChatStore.setState({
      currentSessionKey: recordKeyForSession('agent:main:main'),
      sessionCatalogStatus: buildReadySessionCatalogStatus(sessions),
      loadedSessions: {
        [recordKeyForSession('agent:main:main')]: createSessionRecord({ sessionKey: 'agent:main:main', historyStatus: 'ready' }),
        [recordKeyForSession('agent:test:main')]: createSessionRecord({ sessionKey: 'agent:test:main', historyStatus: 'ready' }),
      },
      switchSession: vi.fn(),
      newSession: vi.fn(),
      newSessionForScope,
      deleteSession: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);

    renderPane();

    fireEvent.click(screen.getByTestId('agent-new-session-test'));
    expect(newSessionForScope).toHaveBeenCalledWith(openClawTestScope);
  });

  it('runtime catalog 增加第二个 endpoint 后 Switchboard 不需要 remount 就展示新 runtime', () => {
    useChatStore.setState({
      sessionRuntimeCatalog: {
        status: 'ready',
        error: null,
        endpoints: [buildReadySessionRuntimeCatalog().endpoints[1]!],
        defaultSessionPromptScope: matchaAgentMatchaScope,
      },
    } as never);
    syncChatSessionRuntimeState();

    renderPane();

    let switchboard = screen.getByTestId('chat-switchboard');
    expect(within(switchboard).queryByText('OpenClaw')).toBeNull();
    expect(within(switchboard).getAllByText('Matcha Agent').length).toBeGreaterThan(0);
    expect(screen.getByTestId('agent-item-matcha')).toBeTruthy();

    act(() => {
      useChatStore.setState({
        sessionRuntimeCatalog: buildReadySessionRuntimeCatalog(),
      } as never);
      syncChatSessionRuntimeState();
    });

    switchboard = screen.getByTestId('chat-switchboard');
    expect(within(switchboard).getAllByText('OpenClaw').length).toBeGreaterThan(0);
    expect(within(switchboard).getAllByText('Matcha Agent').length).toBeGreaterThan(0);
    expect(screen.getByTestId('agent-item-main')).toBeTruthy();
    expect(screen.getByTestId('agent-item-matcha')).toBeTruthy();
  });

  it('点击 OpenClaw agent 行时优先恢复该 agent 的最近会话', () => {
    const openClawMainKey = recordKeyForSession('agent:main:main');
    const openClawRecentKey = recordKeyForSession('agent:test:session-recent');
    const matchaIdentity = createMatchaAgentSessionIdentity();
    const matchaKey = recordKeyForSession('agent:matcha:main', matchaIdentity);
    useChatStore.setState({
      currentSessionKey: matchaKey,
      lastSelectedSessionKeyByRuntimeScopeKey: {
        [buildRuntimeEndpointKey(openClawTestRuntimeEndpoint)]: openClawRecentKey,
        [buildRuntimeEndpointKey(matchaAgentTestRuntimeEndpoint)]: matchaKey,
      },
      sessionCatalogStatus: buildReadySessionCatalogStatus([
        { key: 'agent:main:main', displayName: 'agent:main:main' },
        { key: 'agent:test:session-recent', displayName: '上次 OpenClaw 会话' },
        { key: 'agent:matcha:main', displayName: 'agent:matcha:main' },
      ]),
      loadedSessions: {
        [openClawMainKey]: createSessionRecord({ sessionKey: 'agent:main:main', historyStatus: 'ready' }),
        [openClawRecentKey]: createSessionRecord({
          sessionKey: 'agent:test:session-recent',
          historyStatus: 'ready',
          label: '上次 OpenClaw 会话',
          lastActivityAt: Date.now(),
        }),
        [matchaKey]: createSessionRecord({
          sessionKey: 'agent:matcha:main',
          sessionIdentity: matchaIdentity,
          historyStatus: 'ready',
        }),
      },
      switchSession: vi.fn((sessionKey: string) => {
        useChatStore.setState({
          currentSessionKey: sessionKey,
          currentConversation: buildCurrentConversationFromSessionRecord(useChatStore.getState().loadedSessions[sessionKey]!),
        } as never);
      }),
      newSession: vi.fn(),
      newSessionForScope: vi.fn().mockResolvedValue(undefined),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);
    syncChatSessionRuntimeState();

    renderPane();

    fireEvent.click(screen.getByTestId('agent-item-test'));

    expect(useChatStore.getState().currentSessionKey).toBe(openClawRecentKey);
    expect(screen.queryByTestId('chat-switchboard')).toBeNull();
  });

  it('点击没有缓存 session 的 Matcha Agent 行时进入 draft 且不创建远端会话', () => {
    const newSession = vi.fn();
    const newSessionForScope = vi.fn().mockResolvedValue(undefined);
    const openAgentConversation = vi.fn((agentId: string) => {
      useChatStore.setState({
        currentSessionKey: '',
        currentConversation: {
          kind: 'draft',
          runtimeScopeKey: buildRuntimeEndpointKey(matchaAgentTestRuntimeEndpoint),
          endpoint: matchaAgentTestRuntimeEndpoint,
          agentId,
          sessionPromptScope: matchaAgentMatchaScope,
        },
      } as never);
    });
    useChatStore.setState({
      currentSessionKey: recordKeyForSession('agent:main:main'),
      lastSelectedSessionKeyByRuntimeScopeKey: {},
      sessionCatalogStatus: buildReadySessionCatalogStatus([
        { key: 'agent:main:main', displayName: 'agent:main:main' },
      ]),
      loadedSessions: {
        [recordKeyForSession('agent:main:main')]: createSessionRecord({ sessionKey: 'agent:main:main', historyStatus: 'ready' }),
      },
      switchSession: vi.fn(),
      openAgentConversation,
      newSession,
      newSessionForScope,
      deleteSession: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);
    syncChatSessionRuntimeState();

    renderPane();

    fireEvent.click(screen.getByTestId('agent-item-matcha'));

    expect(openAgentConversation).toHaveBeenCalledWith('matcha', matchaAgentTestRuntimeEndpoint);
    expect(useChatStore.getState().currentSessionKey).toBe('');
    expect(useChatStore.getState().currentConversation).toMatchObject({
      kind: 'draft',
      runtimeScopeKey: buildRuntimeEndpointKey(matchaAgentTestRuntimeEndpoint),
      agentId: 'matcha',
    });
    expect(newSession).not.toHaveBeenCalled();
    expect(newSessionForScope).not.toHaveBeenCalled();
  });

  it('Agent tab 按 runtime 分组，并用对应 runtime scope 新建会话', () => {
    const newSessionForScope = vi.fn().mockResolvedValue(undefined);
    useChatStore.setState({
      currentSessionKey: recordKeyForSession('agent:main:main'),
      sessionCatalogStatus: buildReadySessionCatalogStatus([
        { key: 'agent:main:main', displayName: 'agent:main:main' },
      ]),
      loadedSessions: {
        [recordKeyForSession('agent:main:main')]: createSessionRecord({ sessionKey: 'agent:main:main', historyStatus: 'ready' }),
      },
      switchSession: vi.fn(),
      newSession: vi.fn(),
      newSessionForScope,
      deleteSession: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);

    renderPane();

    const switchboard = screen.getByTestId('chat-switchboard');
    expect(within(switchboard).getAllByText('OpenClaw').length).toBeGreaterThan(0);
    expect(within(switchboard).getAllByText('Matcha Agent').length).toBeGreaterThan(0);
    expect(screen.getByTestId('agent-item-main')).toBeTruthy();
    expect(screen.getByTestId('agent-item-test')).toBeTruthy();
    expect(screen.getByTestId('agent-item-matcha')).toBeTruthy();
    expect(screen.queryByTestId('agent-item-default')).toBeNull();

    fireEvent.click(screen.getByTestId('agent-new-session-main'));
    expect(newSessionForScope).toHaveBeenCalledTimes(1);
    expect(newSessionForScope).toHaveBeenCalledWith(openClawMainScope);
    expect(newSessionForScope).not.toHaveBeenCalledWith(openClawDefaultScope);
    newSessionForScope.mockClear();

    fireEvent.click(screen.getByTestId('agent-session-identity-beacon'));
    fireEvent.click(screen.getByTestId('agent-new-session-matcha'));
    expect(newSessionForScope).toHaveBeenCalledTimes(1);
    expect(newSessionForScope).toHaveBeenCalledWith(matchaAgentMatchaScope);
    expect(newSessionForScope).not.toHaveBeenCalledWith(openClawMainScope);
  });

  it('Matcha Agent 列表不消费 OpenClaw subagent management 错误', () => {
    useSubagentsStore.setState({
      agents: [],
      agentsResource: {
        status: 'error',
        error: 'Subagent management is unavailable',
        hasLoadedOnce: false,
        lastLoadedAt: null,
      },
    } as never);

    renderPane();

    const openClawSection = screen.getByTestId('agent-list-error').closest('section');
    const matchaSection = screen.getByTestId('agent-item-matcha').closest('section');
    expect(openClawSection).toBeTruthy();
    expect(matchaSection).toBeTruthy();
    expect(within(openClawSection!).getByTestId('agent-list-error')).toHaveTextContent('Subagent management is unavailable');
    expect(within(matchaSection!).queryByTestId('agent-list-error')).toBeNull();
  });

  it('优先使用 catalog displayName 展示未 hydrate 历史会话标题', () => {
    const now = Date.now();
    useChatStore.setState({
      currentSessionKey: recordKeyForSession('agent:main:main'),
      sessionCatalogStatus: buildReadySessionCatalogStatus([
        { key: 'agent:main:main', displayName: 'agent:main:main' },
        { key: 'agent:test:main', displayName: 'agent:test:main' },
        { key: 'agent:test:session-2', displayName: 'catalog title from transcript' },
      ]),
      loadedSessions: {
        [recordKeyForSession('agent:main:main')]: createSessionRecord({ sessionKey: 'agent:main:main', historyStatus: 'ready' }),
        [recordKeyForSession('agent:test:main')]: createSessionRecord({ sessionKey: 'agent:test:main', historyStatus: 'ready' }),
        [recordKeyForSession('agent:test:session-2')]: createSessionRecord({
          sessionKey: 'agent:test:session-2',
          historyStatus: 'idle',
          displayName: 'catalog title from transcript',
          lastActivityAt: now,
        }),
      },
      switchSession: vi.fn(),
      newSession: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);
    syncChatSessionRuntimeState();

    renderPane({ tab: 'session' });

    expect(screen.getByText('catalog title from transcript')).toBeTruthy();
    expect(screen.queryByText('New Session')).not.toBeInTheDocument();
    expect(screen.queryByText('Untitled Session')).not.toBeInTheDocument();
  });

  it('点击历史会话项时，应立即切换 current session，不走额外导航链路', () => {
    const switchSession = vi.fn();
    const now = Date.now();
    const sessions = [
      { key: 'agent:main:main', displayName: 'agent:main:main' },
      { key: 'agent:test:main', displayName: 'agent:test:main' },
      { key: 'agent:test:session-2', displayName: 'agent:test:session-2' },
    ];
    useChatStore.setState({
      currentSessionKey: recordKeyForSession('agent:main:main'),
      sessionCatalogStatus: buildReadySessionCatalogStatus(sessions),
      loadedSessions: {
        [recordKeyForSession('agent:main:main')]: createSessionRecord({ sessionKey: 'agent:main:main', historyStatus: 'ready' }),
        [recordKeyForSession('agent:test:main')]: createSessionRecord({ sessionKey: 'agent:test:main', historyStatus: 'ready' }),
        [recordKeyForSession('agent:test:session-2')]: createSessionRecord({
          sessionKey: 'agent:test:session-2',
          historyStatus: 'ready',
          label: '测试Agent会话',
          lastActivityAt: now,
        }),
      },
      switchSession,
      newSession: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);

    renderPane({ tab: 'session' });

    const sessionTitle = screen.getByText('测试Agent会话');
    const sessionButton = sessionTitle.closest('button');
    expect(sessionButton).toBeTruthy();
    if (!sessionButton) {
      return;
    }
    fireEvent.click(sessionButton);

    expect(switchSession).toHaveBeenCalledWith(recordKeyForSession('agent:test:session-2'));
  });

  it('缺少 catalog agentId 时，会话列表从 session key 派生所属 agent', () => {
    const now = Date.now();
    useChatStore.setState({
      currentSessionKey: recordKeyForSession('agent:test:main'),
      sessionCatalogStatus: buildReadySessionCatalogStatus([
        { key: 'agent:test:main', displayName: 'agent:test:main' },
        { key: 'agent:test:session-2', displayName: 'agent:test:session-2' },
      ]),
      loadedSessions: {
        [recordKeyForSession('agent:test:main')]: createSessionRecord({ sessionKey: 'agent:test:main', historyStatus: 'ready' }),
        [recordKeyForSession('agent:test:session-2')]: {
          ...createSessionRecord({
            sessionKey: 'agent:test:session-2',
            historyStatus: 'ready',
            label: '缺少 agentId 的会话',
            lastActivityAt: now,
          }),
          meta: {
            ...createSessionRecord({ sessionKey: 'agent:test:session-2' }).meta,
            agentId: null,
            historyStatus: 'ready',
            label: '缺少 agentId 的会话',
            lastActivityAt: now,
          },
        },
      },
      switchSession: vi.fn(),
      newSession: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);
    syncChatSessionRuntimeState();

    renderPane({ tab: 'session' });

    expect(screen.getByText('缺少 agentId 的会话')).toBeTruthy();
    expect(screen.getByTestId(`session-avatar-${recordKeyForSession('agent:test:session-2')}`)).toBeTruthy();
  });

  it('点击无历史会话的 agent 行，应进入对应 agent draft，不创建会话', () => {
    const switchSession = vi.fn();
    const openAgentConversation = vi.fn();
    const newSessionForScope = vi.fn().mockResolvedValue(undefined);
    const sessions = [
      { key: 'agent:main:main', displayName: 'agent:main:main' },
    ];
    useChatStore.setState({
      currentSessionKey: recordKeyForSession('agent:main:main'),
      sessionCatalogStatus: buildReadySessionCatalogStatus(sessions),
      loadedSessions: {
        [recordKeyForSession('agent:main:main')]: createSessionRecord({ sessionKey: 'agent:main:main', historyStatus: 'ready' }),
      },
      switchSession,
      newSession: vi.fn(),
      newSessionForScope,
      openAgentConversation,
      deleteSession: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);

    renderPane();
    fireEvent.click(screen.getByTestId('agent-item-test'));

    expect(openAgentConversation).toHaveBeenCalledWith('test', openClawTestRuntimeEndpoint);
    expect(newSessionForScope).not.toHaveBeenCalled();
    expect(switchSession).not.toHaveBeenCalled();
  });

  it('按今天、7 天、30 天和更早分桶，并默认展开近期分桶', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-05T12:00:00+08:00'));
    try {
      const now = Date.now();
      const sessions = [
        { key: 'agent:main:main', displayName: 'agent:main:main' },
        { key: 'agent:main:session-today', displayName: 'Today conversation' },
        { key: 'agent:main:session-week', displayName: 'Week conversation' },
        { key: 'agent:main:session-month', displayName: 'Month conversation' },
        { key: 'agent:main:session-older', displayName: 'Older conversation' },
      ];
      useChatStore.setState({
        currentSessionKey: recordKeyForSession('agent:main:main'),
        sessionCatalogStatus: buildReadySessionCatalogStatus(sessions),
        loadedSessions: {
          [recordKeyForSession('agent:main:main')]: createSessionRecord({ sessionKey: 'agent:main:main', historyStatus: 'ready' }),
          [recordKeyForSession('agent:main:session-today')]: createSessionRecord({
            sessionKey: 'agent:main:session-today',
            historyStatus: 'ready',
            label: 'Today conversation',
            lastActivityAt: now - 60 * 60 * 1000,
          }),
          [recordKeyForSession('agent:main:session-week')]: createSessionRecord({
            sessionKey: 'agent:main:session-week',
            historyStatus: 'ready',
            label: 'Week conversation',
            lastActivityAt: now - 2 * 24 * 60 * 60 * 1000,
          }),
          [recordKeyForSession('agent:main:session-month')]: createSessionRecord({
            sessionKey: 'agent:main:session-month',
            historyStatus: 'ready',
            label: 'Month conversation',
            lastActivityAt: now - 10 * 24 * 60 * 60 * 1000,
          }),
          [recordKeyForSession('agent:main:session-older')]: createSessionRecord({
            sessionKey: 'agent:main:session-older',
            historyStatus: 'ready',
            label: 'Older conversation',
            lastActivityAt: now - 40 * 24 * 60 * 60 * 1000,
          }),
        },
        switchSession: vi.fn(),
        newSession: vi.fn(),
        deleteSession: vi.fn().mockResolvedValue(undefined),
        loadSessions: vi.fn().mockResolvedValue(undefined),
      } as never);

      renderPane({ tab: 'session' });

      expect(screen.getAllByText('Today').length).toBeGreaterThan(0);
      expect(screen.getByText('Last 7 Days')).toBeTruthy();
      expect(screen.getByText('Last 30 Days')).toBeTruthy();
      expect(screen.getByText('Older')).toBeTruthy();
      expect(screen.getByText('Today conversation')).toBeTruthy();
      expect(screen.getByText('Week conversation')).toBeTruthy();
      expect(screen.queryByText('Month conversation')).toBeNull();
      expect(screen.queryByText('Older conversation')).toBeNull();

      fireEvent.click(screen.getByText('Last 30 Days').closest('button')!);
      fireEvent.click(screen.getByText('Older').closest('button')!);

      expect(screen.getByText('Month conversation')).toBeTruthy();
      expect(screen.getByText('Older conversation')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('昨天但不足 24 小时的会话不归入今天', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-05T01:00:00+08:00'));
    try {
      useChatStore.setState({
        currentSessionKey: recordKeyForSession('agent:main:main'),
        sessionCatalogStatus: buildReadySessionCatalogStatus([
          { key: 'agent:main:main', displayName: 'agent:main:main' },
          { key: 'agent:main:session-yesterday', displayName: 'Yesterday conversation' },
        ]),
        loadedSessions: {
          [recordKeyForSession('agent:main:main')]: createSessionRecord({ sessionKey: 'agent:main:main', historyStatus: 'ready' }),
          [recordKeyForSession('agent:main:session-yesterday')]: createSessionRecord({
            sessionKey: 'agent:main:session-yesterday',
            historyStatus: 'ready',
            label: 'Yesterday conversation',
            lastActivityAt: new Date('2026-06-04T23:00:00+08:00').getTime(),
          }),
        },
        switchSession: vi.fn(),
        newSession: vi.fn(),
        deleteSession: vi.fn().mockResolvedValue(undefined),
        loadSessions: vi.fn().mockResolvedValue(undefined),
      } as never);

      renderPane({ tab: 'session' });

      expect(screen.queryByText('Today')).toBeNull();
      expect(screen.getByText('Last 7 Days')).toBeTruthy();
      expect(screen.getByText('Yesterday conversation')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('可删除会话并触发 deleteSession', async () => {
    const deleteSession = vi.fn().mockResolvedValue(undefined);
    const now = Date.now();
    const sessions = [
      { key: 'agent:main:main', displayName: 'agent:main:main' },
      { key: 'agent:main:session-1', displayName: 'agent:main:session-1' },
    ];

    useChatStore.setState({
      currentSessionKey: recordKeyForSession('agent:main:main'),
      sessionCatalogStatus: buildReadySessionCatalogStatus(sessions),
      loadedSessions: {
        [recordKeyForSession('agent:main:main')]: createSessionRecord({ sessionKey: 'agent:main:main', historyStatus: 'ready' }),
        [recordKeyForSession('agent:main:session-1')]: createSessionRecord({
          sessionKey: 'agent:main:session-1',
          historyStatus: 'ready',
          label: '需要删除的会话',
          lastActivityAt: now - 1 * 24 * 60 * 60 * 1000,
        }),
      },
      switchSession: vi.fn(),
      newSession: vi.fn(),
      deleteSession,
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);

    renderPane({ tab: 'session' });

    fireEvent.click(screen.getByRole('button', { name: /Delete session .*需要删除的会话/i }));
    expect(screen.getByRole('dialog', { name: /Delete .*需要删除的会话/i })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Confirm Delete/i }));

    await waitFor(() => {
      expect(deleteSession).toHaveBeenCalledWith(recordKeyForSession('agent:main:session-1'));
    });
  });

  it('可重命名会话并触发 renameSession', async () => {
    const renameSession = vi.fn().mockResolvedValue(undefined);
    const now = Date.now();
    useChatStore.setState({
      currentSessionKey: recordKeyForSession('agent:main:main'),
      sessionCatalogStatus: buildReadySessionCatalogStatus([
        { key: 'agent:main:main', displayName: 'agent:main:main' },
        { key: 'agent:main:session-1', displayName: 'agent:main:session-1' },
      ]),
      loadedSessions: {
        [recordKeyForSession('agent:main:main')]: createSessionRecord({ sessionKey: 'agent:main:main', historyStatus: 'ready' }),
        [recordKeyForSession('agent:main:session-1')]: createSessionRecord({
          sessionKey: 'agent:main:session-1',
          historyStatus: 'ready',
          label: 'Old session title',
          lastActivityAt: now,
        }),
      },
      switchSession: vi.fn(),
      newSession: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      renameSession,
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);

    renderPane({ tab: 'session' });

    fireEvent.click(screen.getByRole('button', { name: /Rename session Old session title/i }));
    const input = screen.getByRole('textbox', { name: /Rename session Old session title/i });
    fireEvent.change(input, { target: { value: 'New session title' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(renameSession).toHaveBeenCalledWith(recordKeyForSession('agent:main:session-1'), 'New session title');
    });
  });

  it('agent 列表和会话列表按当前 tab 使用独立滚动区', () => {
    const now = Date.now();
    useSubagentsStore.setState({
      agents: Array.from({ length: 12 }, (_, index) => ({
        id: `agent-${index + 1}`,
        name: `Agent ${index + 1}`,
        isDefault: false,
        avatarSeed: `agent:agent-${index + 1}`,
        avatarStyle: 'pixelArt',
      })),
      loadAgents: vi.fn().mockResolvedValue(undefined),
    } as never);

    useChatStore.setState({
      currentSessionKey: recordKeyForSession('agent:agent-1:main'),
      sessionCatalogStatus: buildReadySessionCatalogStatus(Array.from({ length: 14 }, (_, index) => ({
        key: index === 0 ? 'agent:agent-1:main' : `agent:agent-1:session-${index}`,
        displayName: `agent:agent-1:session-${index}`,
      }))),
      loadedSessions: Object.fromEntries(
        Array.from({ length: 14 }, (_, index) => {
          const key = index === 0 ? 'agent:agent-1:main' : `agent:agent-1:session-${index}`;
          return [
            recordKeyForSession(key),
            createSessionRecord({
              sessionKey: key,
              historyStatus: 'ready',
              label: index === 0 ? null : `会话 ${index}`,
              lastActivityAt: index === 0 ? now : now - index * 60_000,
            }),
          ] as const;
        }),
      ),
      switchSession: vi.fn(),
      newSession: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);
    syncChatSessionRuntimeState();

    renderPane();

    expect(screen.getByTestId('agent-list-scroll-area').className).toContain('overflow-y-auto');
    expect(screen.queryByTestId('session-list-scroll-area')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Sessions' }));

    expect(screen.getByTestId('session-list-scroll-area').className).toContain('overflow-y-auto');
    expect(screen.queryByTestId('agent-list-scroll-area')).toBeNull();
  });

  it('agents 数据未就绪时，不应先渲染占位 avatar 的 agent 行', () => {
    useSubagentsStore.setState({
      agents: [],
      agentsResource: {
        status: 'loading',
        error: null,
        hasLoadedOnce: false,
        lastLoadedAt: null,
      },
      loadAgents: vi.fn().mockResolvedValue(undefined),
    } as never);

    useChatStore.setState({
      currentSessionKey: recordKeyForSession('agent:main:main'),
      sessionCatalogStatus: buildReadySessionCatalogStatus([
        { key: 'agent:main:main', displayName: 'agent:main:main' },
        { key: 'agent:test:main', displayName: 'agent:test:main' },
      ]),
      loadedSessions: {
        [recordKeyForSession('agent:main:main')]: createSessionRecord({ sessionKey: 'agent:main:main', historyStatus: 'ready' }),
        [recordKeyForSession('agent:test:main')]: createSessionRecord({ sessionKey: 'agent:test:main', historyStatus: 'ready' }),
      },
      switchSession: vi.fn(),
      newSession: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);
    syncChatSessionRuntimeState();

    renderPane();

    expect(screen.queryByTestId('agent-item-main')).not.toBeInTheDocument();
    expect(screen.queryByTestId('agent-item-test')).not.toBeInTheDocument();
    expect(screen.getByTestId('agent-list-loading')).toBeTruthy();
  });

  it('agent 资源失败时，不应阻塞会话列表渲染', () => {
    useSubagentsStore.setState({
      agents: [],
      agentsResource: {
        status: 'error',
        error: 'agents failed',
        hasLoadedOnce: false,
        lastLoadedAt: null,
      },
    } as never);

    useChatStore.setState({
      currentSessionKey: recordKeyForSession('agent:test:main'),
      sessionCatalogStatus: buildReadySessionCatalogStatus([
        { key: 'agent:test:main', displayName: 'agent:test:main' },
        { key: 'agent:test:session-2', displayName: 'agent:test:session-2' },
      ]),
      loadedSessions: {
        [recordKeyForSession('agent:test:main')]: createSessionRecord({ sessionKey: 'agent:test:main', historyStatus: 'ready' }),
        [recordKeyForSession('agent:test:session-2')]: createSessionRecord({
          sessionKey: 'agent:test:session-2',
          historyStatus: 'ready',
          label: '测试Agent会话',
          lastActivityAt: Date.now(),
        }),
      },
      switchSession: vi.fn(),
      newSession: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);
    syncChatSessionRuntimeState();

    renderPane();

    expect(screen.getByTestId('agent-list-error')).toHaveTextContent('agents failed');
    fireEvent.click(screen.getByRole('button', { name: 'Sessions' }));
    expect(screen.getByText('测试Agent会话')).toBeTruthy();
  });

  it('会话标题消费本地 authoritative label，而不是回退旧值', () => {
    const now = Date.now();
    useChatStore.setState({
      currentSessionKey: recordKeyForSession('agent:test:session-2'),
      sessionCatalogStatus: buildReadySessionCatalogStatus([
        { key: 'agent:test:main', displayName: 'agent:test:main' },
        { key: 'agent:test:session-2', displayName: 'agent:test:session-2' },
      ]),
      loadedSessions: {
        [recordKeyForSession('agent:test:main')]: createSessionRecord({ sessionKey: 'agent:test:main', historyStatus: 'ready' }),
        [recordKeyForSession('agent:test:session-2')]: createSessionRecord({
          sessionKey: 'agent:test:session-2',
          historyStatus: 'ready',
          label: '最新输入标题',
          lastActivityAt: now,
        }),
      },
      switchSession: vi.fn(),
      newSession: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);
    useChatStore.setState({
      loadedSessions: {
        ...useChatStore.getState().loadedSessions,
        [recordKeyForSession('agent:test:session-2')]: {
          ...useChatStore.getState().loadedSessions[recordKeyForSession('agent:test:session-2')],
          meta: {
            ...useChatStore.getState().loadedSessions[recordKeyForSession('agent:test:session-2')]!.meta,
            label: '最新输入标题',
          },
          items: buildRenderItemsFromMessages('agent:test:session-2', [
            {
              role: 'user',
              content: '最新输入标题',
              id: 'optimistic-user-1',
              timestamp: now / 1000,
            },
          ]),
        },
      },
    } as never);

    renderPane({ tab: 'session' });

    expect(screen.getByText('最新输入标题')).toBeTruthy();
    expect(screen.queryByText('旧标题')).not.toBeInTheDocument();
  });

  it('会话标题在窗口正文已加载后，应消费同步后的 authoritative label', () => {
    const now = Date.now();
    useChatStore.setState({
      currentSessionKey: recordKeyForSession('agent:test:session-2'),
      sessionCatalogStatus: buildReadySessionCatalogStatus([
        { key: 'agent:test:main', displayName: 'agent:test:main' },
        { key: 'agent:test:session-2', displayName: 'agent:test:session-2' },
      ]),
      loadedSessions: {
        [recordKeyForSession('agent:test:main')]: createSessionRecord({ sessionKey: 'agent:test:main', historyStatus: 'ready' }),
        [recordKeyForSession('agent:test:session-2')]: createSessionRecord({
          sessionKey: 'agent:test:session-2',
          historyStatus: 'ready',
          label: '正文里的新标题',
          lastActivityAt: now,
          messages: [
            {
              role: 'user',
              content: '正文里的新标题',
              id: 'user-1',
              timestamp: now / 1000,
            },
          ],
        }),
      },
      switchSession: vi.fn(),
      newSession: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);
    syncChatSessionRuntimeState();

    renderPane({ tab: 'session' });

    expect(screen.getByText('正文里的新标题')).toBeTruthy();
    expect(screen.queryByText('旧标题')).not.toBeInTheDocument();
  });

  it('会话列表不应把裸 session key displayName 当成正式标题 fallback', () => {
    const now = Date.now();
    useChatStore.setState({
      currentSessionKey: recordKeyForSession('agent:test:session-1710000000000'),
      sessionCatalogStatus: buildReadySessionCatalogStatus([
        { key: 'agent:test:main', displayName: 'agent:test:main' },
        { key: 'agent:test:session-1710000000000', displayName: 'agent:test:session-1710000000000' },
      ]),
      loadedSessions: {
        [recordKeyForSession('agent:test:main')]: createSessionRecord({ sessionKey: 'agent:test:main', historyStatus: 'ready' }),
        [recordKeyForSession('agent:test:session-1710000000000')]: createSessionRecord({
          sessionKey: 'agent:test:session-1710000000000',
          historyStatus: 'ready',
          label: null,
          lastActivityAt: now,
          messages: [],
        }),
      },
      switchSession: vi.fn(),
      newSession: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);
    syncChatSessionRuntimeState();

    renderPane({ tab: 'session' });

    expect(screen.queryByText('agent:test:session-1710000000000')).not.toBeInTheDocument();
  });

  it('没有 main 入口时不应把第一条真实历史会话当 preferred 入口过滤掉', () => {
    useChatStore.setState({
      currentSessionKey: recordKeyForSession('agent:test:session-1710000000000'),
      sessionCatalogStatus: buildReadySessionCatalogStatus([
        { key: 'agent:test:session-1710000000000', displayName: '真实历史会话' },
      ]),
      loadedSessions: {
        [recordKeyForSession('agent:test:session-1710000000000')]: createSessionRecord({
          sessionKey: 'agent:test:session-1710000000000',
          historyStatus: 'ready',
          label: '真实历史会话',
          lastActivityAt: Date.now(),
        }),
      },
      switchSession: vi.fn(),
      newSession: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);
    syncChatSessionRuntimeState();

    renderPane({ tab: 'session' });

    expect(screen.getByText('真实历史会话')).toBeTruthy();
  });

  it('没有当前 agent 时不应高亮第一条 agent', () => {
    useChatStore.setState({
      currentSessionKey: '',
      loadedSessions: {},
      sessionCatalogStatus: buildReadySessionCatalogStatus([]),
      switchSession: vi.fn(),
      newSession: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);
    syncChatSessionRuntimeState();

    renderPane();

    expect(screen.getByTestId('agent-item-main').parentElement?.className).toContain('text-muted-foreground');
    expect(screen.getByTestId('agent-item-test').parentElement?.className).toContain('text-muted-foreground');
  });

  it('没有当前 agent 和 agent 列表时，新建按钮不应伪造成 main agent', () => {
    const newSession = vi.fn();
    useSubagentsStore.setState({
      agents: [],
      agentsResource: readyResource,
    } as never);
    useChatStore.setState({
      currentSessionKey: '',
      loadedSessions: {},
      sessionCatalogStatus: buildReadySessionCatalogStatus([]),
      switchSession: vi.fn(),
      newSession,
      deleteSession: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);

    renderPane({ open: false });

    fireEvent.click(screen.getByTestId('agent-session-new-current'));
    expect(newSession).not.toHaveBeenCalled();
  });

  it('会话资源加载中时，不应阻塞 agent 列表渲染', () => {
    useChatStore.setState({
      currentSessionKey: recordKeyForSession('agent:main:main'),
      loadedSessions: {},
      sessionCatalogStatus: {
        status: 'loading',
        error: null,
        hasLoadedOnce: false,
        lastLoadedAt: null,
      },
      switchSession: vi.fn(),
      newSession: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);
    syncChatSessionRuntimeState();

    renderPane();

    expect(screen.getByTestId('agent-item-main')).toBeTruthy();
    expect(screen.getByTestId('agent-item-test')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sessions' }));
    expect(screen.getByTestId('session-list-loading')).toBeTruthy();
  });

  it('session 资源失败时，不应阻塞 agent 列表渲染', () => {
    useChatStore.setState({
      currentSessionKey: recordKeyForSession('agent:main:main'),
      loadedSessions: {},
      sessionCatalogStatus: {
        status: 'error',
        error: 'sessions failed',
        hasLoadedOnce: false,
        lastLoadedAt: null,
      },
      switchSession: vi.fn(),
      newSession: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);
    syncChatSessionRuntimeState();

    renderPane();

    expect(screen.getByTestId('agent-item-main')).toBeTruthy();
    expect(screen.getByTestId('agent-item-test')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sessions' }));
    expect(screen.getByTestId('session-list-error')).toHaveTextContent('sessions failed');
  });

  it('只要 loadedSessions 已经有会话集合，session resource loading/error 都不应覆盖正文来源的会话列表', () => {
    const now = Date.now();
    useChatStore.setState({
      currentSessionKey: recordKeyForSession('agent:test:main'),
      sessionCatalogStatus: {
        status: 'loading',
        error: 'sessions failed',
        hasLoadedOnce: false,
        lastLoadedAt: null,
      },
      loadedSessions: {
        [recordKeyForSession('agent:test:main')]: createSessionRecord({ sessionKey: 'agent:test:main', historyStatus: 'ready' }),
        [recordKeyForSession('agent:test:session-2')]: createSessionRecord({
          sessionKey: 'agent:test:session-2',
          historyStatus: 'ready',
          label: '正文来源会话',
          lastActivityAt: now,
        }),
      },
      switchSession: vi.fn(),
      newSession: vi.fn(),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);
    syncChatSessionRuntimeState();

    renderPane({ tab: 'session' });

    expect(screen.queryByTestId('session-list-loading')).not.toBeInTheDocument();
    expect(screen.queryByTestId('session-list-error')).not.toBeInTheDocument();
    expect(screen.getByText('正文来源会话')).toBeTruthy();
  });

  it('新建空会话应使用 session key 时间戳参与分桶，而不是被误归到很久以前', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_710_000_600_000));
    try {
      useChatStore.setState({
        currentSessionKey: recordKeyForSession('agent:test:session-1710000000000'),
        sessionCatalogStatus: buildReadySessionCatalogStatus([
          { key: 'agent:test:main', displayName: 'agent:test:main' },
          { key: 'agent:test:session-1700000000000', displayName: 'agent:test:session-1700000000000' },
          { key: 'agent:test:session-1710000000000', displayName: 'agent:test:session-1710000000000' },
        ]),
        loadedSessions: {
          [recordKeyForSession('agent:test:main')]: createSessionRecord({ sessionKey: 'agent:test:main', historyStatus: 'ready' }),
          [recordKeyForSession('agent:test:session-1700000000000')]: createSessionRecord({
            sessionKey: 'agent:test:session-1700000000000',
            historyStatus: 'ready',
            label: '旧空会话',
          }),
          [recordKeyForSession('agent:test:session-1710000000000')]: createSessionRecord({
            sessionKey: 'agent:test:session-1710000000000',
            historyStatus: 'ready',
            label: '新空会话',
          }),
        },
        switchSession: vi.fn(),
        newSession: vi.fn(),
        deleteSession: vi.fn().mockResolvedValue(undefined),
        loadSessions: vi.fn().mockResolvedValue(undefined),
      } as never);

      renderPane({ tab: 'session' });

      expect(screen.getByText('新空会话')).toBeTruthy();
      expect(screen.queryByText('旧空会话')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
