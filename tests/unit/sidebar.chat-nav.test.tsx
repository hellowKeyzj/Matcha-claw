import { beforeAll, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { Sidebar } from '@/app/layout/Sidebar';
import { useChatStore } from '@/plugins/chat/store';
import { createPluginHost, type PreloadableComponent } from '@/plugin-host/core';
import { PluginHostProvider } from '@/plugin-host/react';
import { applicationShellPlugin, sidebarActions, sidebarFooter, sidebarPanels } from '@/app/extensions';
import { agentsPlugin } from '@/plugins/agents/plugin';
import { navigationPlugin } from '@/plugins/navigation/plugin';
import { useAccountStore } from '@/plugins/account/stores/account';
import { useRuntimeHostStore } from '@/plugins/runtime/store';
import { useLayoutStore } from '@/app/layout/store';
import { useSettingsStore } from '@/plugins/settings/store';
import { useSubagentsStore } from '@/plugins/agents/stores/subagents';
import { useTeamsStore } from '@/plugins/teams/store';
import { useTaskCenterStore } from '@/plugins/tasks/stores/task-center-store';
import i18n from '@/i18n';
import { createEmptySessionRecord } from '@/plugins/chat/store/store-state-helpers';

const host = createPluginHost([applicationShellPlugin, agentsPlugin, navigationPlugin]);

beforeAll(async () => {
  await Promise.all([sidebarActions, sidebarPanels, sidebarFooter].flatMap((point) => (
    host.get(point).map(({ component }) => (component as PreloadableComponent<object>).preload())
  )));
});

const endpoint = {
  kind: 'native-runtime' as const,
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
};

vi.mock('@/plugins/teams/feature-flag', () => ({
  TEAMS_FEATURE_ENABLED: true,
}));

function LocationEcho() {
  const location = useLocation();
  return <div data-testid="location-echo">{`${location.pathname}${location.search}`}</div>;
}

async function mountSidebar(initialPath: string) {
  await act(async () => {
    render(
      <PluginHostProvider host={host}>
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
        </MemoryRouter>
      </PluginHostProvider>,
    );
  });
}

function createSessionRecord(input?: {
  sessionKey?: string;
  messages?: Array<{ role: 'user' | 'assistant'; content: string }>;
  label?: string | null;
  historyStatus?: 'idle' | 'loading' | 'ready' | 'error';
}) {
  const recordKey = input?.sessionKey ?? 'agent:main:main';
  const messages = input?.messages ?? [];
  const base = createEmptySessionRecord();
  return {
    meta: {
      ...base.meta,
      agentId: recordKey.split(':')[1] ?? null,
      sessionIdentity: {
        endpoint,
        agentId: recordKey.split(':')[1] ?? 'main',
        sessionKey: recordKey,
      },
      label: input?.label ?? null,
      historyStatus: input?.historyStatus ?? 'idle',
    },
    runtime: {
      ...base.runtime,
    },
    items: messages.map((message, index) => ({
      id: `${recordKey}:${index}`,
      kind: 'message' as const,
      message: {
        id: `${recordKey}:${index}`,
        role: message.role,
        content: message.content,
      },
    })),
    window: {
      totalItemCount: messages.length,
      windowStartOffset: 0,
      windowEndOffset: messages.length,
      isAtLatest: true,
    },
  };
}

function setupSidebarState() {
  useAccountStore.setState({ status: 'signedIn' });
  useSettingsStore.setState({
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
  useRuntimeHostStore.setState({
    runtimeHost: { lifecycle: 'running' },
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
    refreshActiveRunViews: vi.fn().mockResolvedValue(undefined),
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
  i18n.changeLanguage('en');
}

describe('sidebar chat nav', () => {
  it('renders nav labels in the sidebar drawer', async () => {
    setupSidebarState();

    await mountSidebar('/dashboard');

    expect(screen.getByText('New Chat')).toBeInTheDocument();
    expect(screen.getByText('Subagents')).toBeInTheDocument();
  });

  it('does not animate sidebar width changes on the outer shell', async () => {
    setupSidebarState();

    await mountSidebar('/dashboard');

    const sidebar = screen.getByRole('complementary');
    expect(sidebar.className).not.toContain('transition-[width]');
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

    await mountSidebar('/tasks');

    fireEvent.click(screen.getByRole('button', { name: 'New Chat' }));

    expect(newSession).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByTestId('location-echo')).toHaveTextContent('/');
    });
  });

  it('on chat route, clicking chat creates new session when current session has messages', async () => {
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

    await mountSidebar('/');

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

    await mountSidebar('/dashboard');

    expect(screen.getByText('Session Blockers')).toBeInTheDocument();
    expect(screen.getByText('Stage stage-123')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Stage stage-123/i }));
    await waitFor(() => {
      expect(screen.getByTestId('location-echo')).toHaveTextContent('/teams/team-1');
    });
  });

  it('hides Team approval blockers when the sealed pending query is empty', async () => {
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
      approvalsByTeamId: { 'team-1': [] },
    } as never);

    await mountSidebar('/dashboard');

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
            sessionIdentity: {
              endpoint,
              agentId: 'analytics',
              sessionKey: 'agent:analytics:main',
            },
            title: 'approval-chat-1',
            allowedDecisions: ['allow-once'],
            createdAtMs: 1,
          },
        ],
      },
    } as never);

    await mountSidebar('/dashboard');

    const approvalCard = await screen.findByRole('button', { name: /approval-chat-1/i });
    expect(approvalCard).toBeInTheDocument();
    fireEvent.click(approvalCard);
    await waitFor(() => {
      expect(screen.getByTestId('location-echo')).toHaveTextContent('/?session=agent%3Aanalytics%3Amain');
    });
  });

  it('chat approval blocker cache should not depend on session displayName fallback', async () => {
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
            sessionIdentity: {
              endpoint,
              agentId: 'main',
              sessionKey: 'agent:main:main',
            },
            title: 'approval-chat-1',
            allowedDecisions: ['allow-once'],
            createdAtMs: 1,
          },
        ],
      },
    } as never);

    await mountSidebar('/dashboard');

    expect(screen.queryByText('MatchaClaw Runtime Host')).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /approval-chat-1/i })).toBeInTheDocument();
  });
});
