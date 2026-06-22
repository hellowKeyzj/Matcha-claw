import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AgentSessionsPane } from '@/components/layout/AgentSessionsPane';
import { useChatStore } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import { useSubagentsStore } from '@/stores/subagents';
import { useTeamsStore } from '@/stores/teams';
import i18n from '@/i18n';
import { createEmptySessionRecord } from '@/stores/chat/store-state-helpers';
import { buildRenderItemsFromMessages } from './helpers/timeline-fixtures';
import type { RawMessage } from './helpers/timeline-fixtures';
import { createViewportWindowState } from '@/stores/chat/viewport-state';
import { buildRuntimeEndpointKey, buildSessionIdentityKey, type SessionIdentity } from '../../runtime-host/shared/runtime-address';
import { createOpenClawTestSessionIdentity } from './helpers/runtime-address-fixtures';

const readyResource = {
  status: 'ready' as const,
  error: null,
  hasLoadedOnce: true,
  lastLoadedAt: 1,
};

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

function recordKeyForSession(sessionKey: string, identity = createSessionIdentity(sessionKey)): string {
  return buildSessionIdentityKey(identity);
}

function createSessionRecord(input?: {
  sessionKey?: string;
  agentId?: string | null;
  sessionIdentity?: SessionIdentity;
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
      backendSessionKey: sessionKey,
      runtimeScopeKey: buildRuntimeEndpointKey(sessionIdentity.endpoint),
      agentId: input?.agentId === undefined ? sessionIdentity.agentId : input.agentId,
      protocolId: null,
      runtimeEndpointId: 'local',
      sessionIdentity,
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
    sessionCatalogStatus: readyResource,
  } as never);
}

function renderPane() {
  render(
    <MemoryRouter>
      <AgentSessionsPane />
    </MemoryRouter>,
  );
}

describe('agent sessions pane', () => {
  beforeEach(() => {
    window.localStorage.clear();
    i18n.changeLanguage('en');
    setupBaseState();
  });

  it('在 team tab 展示 Team → Run → leader/roles，点击 run 后选择并刷新 snapshot', async () => {
    const leaderIdentity = createSessionIdentity('agent:leader-agent:main', 'leader-agent');
    const roleIdentity = createSessionIdentity('agent:designer-agent:main', 'designer-agent');
    const setActiveRun = vi.fn();
    const createRun = vi.fn().mockResolvedValue(undefined);
    const syncRunList = vi.fn().mockResolvedValue(undefined);
    const refreshSnapshot = vi.fn().mockResolvedValue(undefined);
    const openSessionIdentity = vi.fn();
    useChatStore.setState({
      openSessionIdentity,
    } as never);
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
            sessions: [],
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
              { runId: 'teamrun-new', roleId: 'leader', agentId: 'leader-agent', sessionKey: 'agent:leader-agent:main', sessionIdentity: leaderIdentity },
              { runId: 'teamrun-new', roleId: 'designer', agentId: 'designer-agent', sessionKey: 'agent:designer-agent:main', sessionIdentity: roleIdentity },
            ],
          },
        ],
      },
      setActiveRun,
      createRun,
      syncRunList,
      refreshSnapshot,
    } as never);

    renderPane();

    fireEvent.click(screen.getByRole('button', { name: 'Teams' }));
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
    expect(openSessionIdentity).not.toHaveBeenCalled();
    expect(refreshSnapshot).toHaveBeenCalledWith('team-1', { force: true });

    fireEvent.click(screen.getByRole('button', { name: /teamrun-new/i }));
    expect(setActiveRun).toHaveBeenCalledWith('team-1', 'teamrun-new');
    expect(openSessionIdentity).toHaveBeenCalledWith(leaderIdentity);

    fireEvent.click(screen.getByRole('button', { name: /teamrun-new/i }).previousElementSibling as HTMLElement);
    expect(screen.queryByRole('button', { name: /Leader session/i })).toBeNull();
    expect(screen.getByRole('button', { name: /designer/i })).toBeTruthy();
  });

  it('将 agent 列表放在上方，会话历史在下方统一展示', async () => {
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

    renderPane();

    expect(screen.getByTestId('agent-item-main')).toBeInTheDocument();
    expect(screen.getByTestId('agent-item-test')).toBeInTheDocument();
    expect(screen.getByTestId('agent-session-avatar-main')).toBeInTheDocument();
    expect(screen.getByTestId('agent-session-avatar-test')).toBeInTheDocument();
    expect(screen.getByText('主Agent会话')).toBeInTheDocument();
    expect(screen.getByText('测试Agent会话')).toBeInTheDocument();
  });

  it('收缩态头像区应负责展开，下半部应给当前 agent 新建会话', () => {
    const onToggleCollapse = vi.fn();
    const newSession = vi.fn();
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
      newSession,
      deleteSession: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);

    render(
      <MemoryRouter>
        <AgentSessionsPane collapsed onToggleCollapse={onToggleCollapse} />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('agent-sessions-collapsed-note')).toBeTruthy();
    expect(screen.getByTestId('agent-sessions-collapsed-avatar')).toBeTruthy();
    expect(screen.getByTestId('agent-sessions-collapsed-new-session')).toBeTruthy();

    fireEvent.click(screen.getByTestId('agent-sessions-collapsed-expand'));
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('agent-sessions-collapsed-new-session'));
    expect(newSession).toHaveBeenCalledWith('test');
  });

  it('点击某个 agent 的新会话按钮，应按对应 agent 创建', async () => {
    const newSession = vi.fn();
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
      newSession,
      deleteSession: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);

    renderPane();

    fireEvent.click(screen.getByTestId('agent-new-session-test'));
    expect(newSession).toHaveBeenCalledWith('test');
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

    renderPane();

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

    renderPane();

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

    renderPane();

    expect(screen.getByText('缺少 agentId 的会话')).toBeTruthy();
    expect(screen.getByTestId(`session-avatar-${recordKeyForSession('agent:test:session-2')}`)).toBeTruthy();
  });

  it('点击无历史会话的 agent 行，应走 agent 打开动作而不是切到伪 main 会话', () => {
    const switchSession = vi.fn();
    const openAgentConversation = vi.fn();
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
      openAgentConversation,
      deleteSession: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);

    renderPane();
    fireEvent.click(screen.getByTestId('agent-item-test'));

    expect(openAgentConversation).toHaveBeenCalledWith('test');
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

      renderPane();

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

      renderPane();

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

    renderPane();

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

    renderPane();

    fireEvent.click(screen.getByRole('button', { name: /Rename session Old session title/i }));
    const input = screen.getByRole('textbox', { name: /Rename session Old session title/i });
    fireEvent.change(input, { target: { value: 'New session title' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(renameSession).toHaveBeenCalledWith(recordKeyForSession('agent:main:session-1'), 'New session title');
    });
  });

  it('agent 列表和会话列表使用两个独立滚动区', () => {
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

    renderPane();

    const agentScrollArea = screen.getByTestId('agent-list-scroll-area');
    const sessionScrollArea = screen.getByTestId('session-list-scroll-area');

    expect(agentScrollArea).toBeTruthy();
    expect(sessionScrollArea).toBeTruthy();
    expect(agentScrollArea).not.toBe(sessionScrollArea);
    expect(agentScrollArea.className).toContain('overflow-y-auto');
    expect(sessionScrollArea.className).toContain('overflow-y-auto');
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

    renderPane();

    expect(screen.getByTestId('agent-list-error')).toHaveTextContent('agents failed');
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

    renderPane();

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

    renderPane();

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

    renderPane();

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

    renderPane();

    expect(screen.getByText('真实历史会话')).toBeTruthy();
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

    renderPane();

    fireEvent.click(screen.getByRole('button', { name: 'New session' }));
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

    renderPane();

    expect(screen.getByTestId('agent-item-main')).toBeTruthy();
    expect(screen.getByTestId('agent-item-test')).toBeTruthy();
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

    renderPane();

    expect(screen.getByTestId('agent-item-main')).toBeTruthy();
    expect(screen.getByTestId('agent-item-test')).toBeTruthy();
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

    renderPane();

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

      renderPane();

      expect(screen.getByText('新空会话')).toBeTruthy();
      expect(screen.queryByText('旧空会话')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
