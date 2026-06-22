import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { Sidebar } from '@/components/layout/Sidebar';
import { useChatStore } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import { useLayoutStore } from '@/stores/layout';
import { useSettingsStore } from '@/stores/settings';
import { useSubagentsStore } from '@/stores/subagents';
import { useTeamsStore } from '@/stores/teams';
import { useTaskCenterStore } from '@/stores/task-center-store';
import { usePluginsStore } from '@/stores/plugins-store';
import i18n from '@/i18n';
import { createEmptySessionRecord } from '@/stores/chat/store-state-helpers';
import { buildRenderItemsFromMessages } from './helpers/timeline-fixtures';
import type { RawMessage } from './helpers/timeline-fixtures';
import { createViewportWindowState } from '@/stores/chat/viewport-state';
import { createOpenClawTestSessionIdentity } from './helpers/runtime-address-fixtures';

vi.mock('@/features/teams/feature-flag', () => ({
  TEAMS_FEATURE_ENABLED: true,
}));

function LocationEcho() {
  const location = useLocation();
  return <div data-testid="location-echo">{`${location.pathname}${location.search}`}</div>;
}

function mountSidebar(initialPath: string) {
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route
          path="*"
          element={(
            <>
              <Sidebar />
              <LocationEcho />
            </>
          )}
        />
      </Routes>
    </MemoryRouter>,
  );
}

function createSessionRecord(input?: {
  sessionKey?: string;
  messages?: RawMessage[];
  label?: string | null;
  historyStatus?: 'idle' | 'loading' | 'ready' | 'error';
}) {
  const recordKey = input?.sessionKey ?? 'agent:main:main';
  const messages = input?.messages ?? [];
  const base = createEmptySessionRecord();
  return {
    meta: {
      ...base.meta,
      backendSessionKey: recordKey,
      agentId: recordKey.split(':')[1] ?? null,
      sessionIdentity: createOpenClawTestSessionIdentity(recordKey),
      label: input?.label ?? null,
      historyStatus: input?.historyStatus ?? 'idle',
    },
    runtime: {
      ...base.runtime,
    },
    items: buildRenderItemsFromMessages(recordKey, messages),
    window: createViewportWindowState({
      totalItemCount: messages.length,
      windowStartOffset: 0,
      windowEndOffset: messages.length,
      isAtLatest: true,
    }),
  };
}

function setupSidebarState() {
  useSettingsStore.setState({
    setupComplete: true,
    language: 'en',
    devModeUnlocked: false,
    init: vi.fn().mockResolvedValue(undefined),
  } as never);
  useLayoutStore.setState({
    sidebarVisible: true,
    sidebarWidth: 256,
  });
  useSubagentsStore.setState({
    agents: [],
    availableModels: [],
    modelsLoading: false,
    snapshotReady: true,
    initialLoading: false,
    refreshing: false,
    mutating: false,
    error: null,
    selectedAgentId: null,
    loadAgents: vi.fn().mockResolvedValue(undefined),
    loadAvailableModels: vi.fn().mockResolvedValue(undefined),
    selectAgent: vi.fn(),
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
  useTeamsStore.setState({
    teams: [],
    activeTeamId: null,
    runIdsByTeamId: {},
    runListByTeamId: {},
    runsById: {},
    runByTeamId: {},
    rolesByTeamId: {},
    stagesByTeamId: {},
    approvalsByTeamId: {},
    messagesByTeamId: {},
    dispatchesByTeamId: {},
    dispatchExecutionsByTeamId: {},
    eventsByTeamId: {},
    eventCursorByTeamId: {},
    loadingByTeamId: {},
    errorByTeamId: {},
    createTeam: vi.fn(),
    setActiveTeam: vi.fn(),
    setActiveRun: vi.fn(),
    syncRunList: vi.fn().mockResolvedValue(undefined),
    deleteTeam: vi.fn(),
    createRun: vi.fn().mockResolvedValue(undefined),
    deleteRun: vi.fn().mockResolvedValue(undefined),
    refreshSnapshot: vi.fn().mockResolvedValue(undefined),
    tickRun: vi.fn().mockResolvedValue(undefined),
    cancelRun: vi.fn().mockResolvedValue(undefined),
    resolveApproval: vi.fn().mockResolvedValue(undefined),
    submitDecision: vi.fn().mockResolvedValue(undefined),
  } as never);
  useTaskCenterStore.setState({
    sessionKey: 'agent:main:main',
    tasks: [],
    initialLoading: false,
    refreshing: false,
    mutating: false,
    initialized: true,
    error: null,
    init: vi.fn().mockResolvedValue(undefined),
    refreshTasks: vi.fn().mockResolvedValue(undefined),
  } as never);
  usePluginsStore.setState({
    prewarm: vi.fn().mockResolvedValue(undefined),
  } as never);
  i18n.changeLanguage('en');
}

describe('sidebar chat nav', () => {
  it('keeps nav labels mounted in the collapsed rail', () => {
    setupSidebarState();
    useLayoutStore.setState({
      sidebarVisible: false,
      sidebarWidth: 256,
    });

    mountSidebar('/dashboard');

    expect(screen.getByText('New Chat')).toBeInTheDocument();
    expect(screen.getByText('Plugin Center')).toBeInTheDocument();
  });

  it('does not animate sidebar width changes on the outer shell', () => {
    setupSidebarState();

    mountSidebar('/dashboard');

    const sidebar = screen.getByRole('complementary');
    expect(sidebar.className).not.toContain('transition-[width]');
  });

  it('hover 插件入口时会预热插件数据', async () => {
    vi.useFakeTimers();
    try {
      setupSidebarState();
      const prewarm = vi.fn().mockResolvedValue(undefined);
      usePluginsStore.setState({ prewarm } as never);

      mountSidebar('/dashboard');

      fireEvent.mouseEnter(screen.getByRole('link', { name: 'Plugin Center' }));
      vi.advanceTimersByTime(140);

      expect(prewarm).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('from non-chat routes, clicking chat only navigates and does not create new session', async () => {
    setupSidebarState();
    const newSession = vi.fn();
    useChatStore.setState({
      sessionCatalogStatus: {
        status: 'ready',
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      currentSessionKey: 'agent:main:main',
      loadedSessions: {
        'agent:main:main': createSessionRecord({
          messages: [{ role: 'user', content: 'existing' }],
          historyStatus: 'ready',
        }),
      },
      newSession,
      switchSession: vi.fn(),
      deleteSession: vi.fn(),
    } as never);

    mountSidebar('/tasks');

    fireEvent.click(screen.getByRole('button', { name: 'New Chat' }));

    expect(newSession).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByTestId('location-echo')).toHaveTextContent('/');
    });
  });

  it('on chat route, clicking chat creates new session when current session has messages', () => {
    setupSidebarState();
    const newSession = vi.fn();
    useChatStore.setState({
      sessionCatalogStatus: {
        status: 'ready',
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      currentSessionKey: 'agent:main:main',
      loadedSessions: {
        'agent:main:main': createSessionRecord({
          messages: [{ role: 'user', content: 'existing' }],
          historyStatus: 'ready',
        }),
      },
      newSession,
      switchSession: vi.fn(),
      deleteSession: vi.fn(),
    } as never);

    mountSidebar('/');

    fireEvent.click(screen.getByRole('button', { name: 'New Chat' }));

    expect(newSession).toHaveBeenCalledTimes(1);
  });

  it('renders pending team approval cards and navigates to team detail', async () => {
    setupSidebarState();
    useTeamsStore.setState({
      teams: [
        {
          id: 'team-1',
          name: 'Team One',
          packagePath: '.tmp/team-skill',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      approvalsByTeamId: {
        'team-1': [
          {
            approvalId: 'approval-1',
            runId: 'team-1',
            stageId: 'stage-123',
            roleId: 'main',
            reason: 'Need decision',
            requestedAction: 'Run profiling',
            status: 'pending',
            idempotencyKey: 'approval-1',
            createdAt: Date.now(),
          },
        ],
      },
    } as never);

    mountSidebar('/dashboard');

    expect(screen.getByText('Session Blockers')).toBeInTheDocument();
    expect(screen.getByText('Stage stage-123')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Stage stage-123/i }));
    await waitFor(() => {
      expect(screen.getByTestId('location-echo')).toHaveTextContent('/teams/team-1');
    });
  });

  it('hides resolved team approval blockers', () => {
    setupSidebarState();
    useTeamsStore.setState({
      teams: [
        {
          id: 'team-1',
          name: 'Team One',
          packagePath: '.tmp/team-skill',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      approvalsByTeamId: {
        'team-1': [
          {
            approvalId: 'approval-2',
            runId: 'team-1',
            stageId: 'stage-456',
            roleId: 'main',
            reason: 'Need decision',
            requestedAction: 'Run profiling',
            status: 'approved',
            idempotencyKey: 'approval-2',
            createdAt: Date.now(),
          },
        ],
      },
    } as never);

    mountSidebar('/dashboard');

    expect(screen.queryByText('Stage stage-456')).not.toBeInTheDocument();
  });

  it('renders chat approval blockers and navigates to target chat session', async () => {
    setupSidebarState();
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      sessionCatalogStatus: {
        status: 'ready',
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      loadedSessions: {
        'agent:main:main': createSessionRecord({ historyStatus: 'ready' }),
        'agent:analytics:main': createSessionRecord({ sessionKey: 'agent:analytics:main', historyStatus: 'ready' }),
      },
      pendingApprovalsBySession: {
        'agent:analytics:main': [
          {
            id: 'approval-chat-1',
            sessionKey: 'agent:analytics:main',
            backendSessionKey: 'agent:analytics:main',
            sessionIdentity: createOpenClawTestSessionIdentity('agent:analytics:main'),
            runId: 'run-chat-1',
            title: 'gateway',
            command: 'Remove-Item demo.txt',
            allowedDecisions: ['allow-once', 'deny'],
            createdAtMs: Date.now(),
          },
        ],
      },
    } as never);

    mountSidebar('/dashboard');

    expect(screen.getByText(/Approval Blocker · gateway/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Approval Blocker · gateway/i }));
    await waitFor(() => {
      expect(screen.getByTestId('location-echo')).toHaveTextContent('/?session=agent%3Aanalytics%3Amain');
    });
  });

  it('chat approval blocker cache should not depend on session displayName fallback', () => {
    setupSidebarState();
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      sessionCatalogStatus: {
        status: 'ready',
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      loadedSessions: {
        'agent:main:main': createSessionRecord({ historyStatus: 'ready', label: null }),
      },
      pendingApprovalsBySession: {
        'agent:main:main': [
          {
            id: 'approval-chat-1',
            sessionKey: 'agent:main:main',
            backendSessionKey: 'agent:main:main',
            sessionIdentity: createOpenClawTestSessionIdentity('agent:main:main'),
            runId: 'run-chat-1',
            title: 'gateway',
            command: 'Remove-Item demo.txt',
            allowedDecisions: ['allow-once', 'deny'],
            createdAtMs: Date.now(),
          },
        ],
      },
    } as never);

    mountSidebar('/dashboard');

    expect(screen.queryByText('MatchaClaw Runtime Host')).not.toBeInTheDocument();
    expect(screen.getByText(/Approval Blocker · gateway/i)).toBeInTheDocument();
  });
});
