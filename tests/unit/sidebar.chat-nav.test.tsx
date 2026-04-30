import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { Sidebar } from '@/components/layout/Sidebar';
import { useChatStore } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import { useSettingsStore } from '@/stores/settings';
import { useSubagentsStore } from '@/stores/subagents';
import { useTeamsStore } from '@/stores/teams';
import { useTaskCenterStore } from '@/stores/task-center-store';
import { usePluginsStore } from '@/stores/plugins-store';
import i18n from '@/i18n';
import type { RawMessage } from '@/stores/chat';
import { createViewportWindowState } from '@/stores/chat/viewport-state';

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
  messages?: RawMessage[];
  label?: string | null;
  ready?: boolean;
}) {
  const messages = input?.messages ?? [];
  return {
    meta: {
      label: input?.label ?? null,
      lastActivityAt: null,
      ready: input?.ready ?? false,
      thinkingLevel: null,
    },
    runtime: {
      sending: false,
      activeRunId: null,
      runPhase: 'idle' as const,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      approvalStatus: 'idle' as const,
    },
    window: createViewportWindowState({
      messages,
      totalMessageCount: messages.length,
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
    sidebarCollapsed: false,
    devModeUnlocked: false,
    init: vi.fn().mockResolvedValue(undefined),
  } as never);
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
    status: { state: 'running', port: 18789 },
    init: vi.fn().mockResolvedValue(undefined),
  } as never);
  useTeamsStore.setState({
    teams: [],
    activeTeamId: null,
    runMetaByTeamId: {},
    tasksByTeamId: {},
    mailboxByTeamId: {},
    mailboxCursorByTeamId: {},
    eventsByTeamId: {},
    loadingByTeamId: {},
    errorByTeamId: {},
    createTeam: vi.fn(),
    setActiveTeam: vi.fn(),
    deleteTeam: vi.fn(),
    initRuntime: vi.fn().mockResolvedValue(undefined),
    refreshSnapshot: vi.fn().mockResolvedValue(undefined),
    planUpsert: vi.fn().mockResolvedValue(undefined),
    claimNext: vi.fn().mockResolvedValue(null),
    heartbeat: vi.fn().mockResolvedValue(true),
    updateTaskStatus: vi.fn().mockResolvedValue(undefined),
    postMailbox: vi.fn().mockResolvedValue(undefined),
    pullMailbox: vi.fn().mockResolvedValue(undefined),
    releaseClaim: vi.fn().mockResolvedValue(undefined),
  } as never);
  useTaskCenterStore.setState({
    tasks: [],
    loading: false,
    initialized: true,
    error: null,
    workspaceDir: null,
    workspaceDirs: [],
    pluginInstalled: true,
    pluginEnabled: true,
    pluginVersion: undefined,
    init: vi.fn().mockResolvedValue(undefined),
    refreshTasks: vi.fn().mockResolvedValue(undefined),
    handleGatewayNotification: vi.fn(),
  } as never);
  usePluginsStore.setState({
    prewarm: vi.fn().mockResolvedValue(undefined),
  } as never);
  i18n.changeLanguage('en');
}

describe('sidebar chat nav', () => {
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
      sessionMetasResource: {
        status: 'ready',
        data: [{ key: 'agent:main:main' }],
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      currentSessionKey: 'agent:main:main',
      loadedSessions: {
        'agent:main:main': createSessionRecord({
          messages: [{ role: 'user', content: 'existing' }],
          ready: true,
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
      sessionMetasResource: {
        status: 'ready',
        data: [{ key: 'agent:main:main' }],
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      currentSessionKey: 'agent:main:main',
      loadedSessions: {
        'agent:main:main': createSessionRecord({
          messages: [{ role: 'user', content: 'existing' }],
          ready: true,
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

  it('renders pending question cards and navigates to team detail', async () => {
    setupSidebarState();
    useTeamsStore.setState({
      teams: [
        {
          id: 'team-1',
          name: 'Team One',
          leadAgentId: 'main',
          memberIds: ['main'],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      mailboxByTeamId: {
        'team-1': [
          {
            msgId: 'q1',
            fromAgentId: 'main',
            to: 'main',
            kind: 'question',
            relatedTaskId: 'task-123',
            content: '[AUTO-BLOCKED] need decision',
            createdAt: Date.now(),
          },
        ],
      },
    } as never);

    mountSidebar('/dashboard');

    expect(screen.getByText('Session Blockers')).toBeInTheDocument();
    expect(screen.getByText('Task task-123')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Task task-123/i }));
    await waitFor(() => {
      expect(screen.getByTestId('location-echo')).toHaveTextContent('/teams/team-1');
    });
  });

  it('hides question blocker when the same task has a newer decision', () => {
    setupSidebarState();
    const now = Date.now();
    useTeamsStore.setState({
      teams: [
        {
          id: 'team-1',
          name: 'Team One',
          leadAgentId: 'main',
          memberIds: ['main'],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      mailboxByTeamId: {
        'team-1': [
          {
            msgId: 'q2',
            fromAgentId: 'main',
            to: 'main',
            kind: 'question',
            relatedTaskId: 'task-456',
            content: 'need decision',
            createdAt: now - 1000,
          },
          {
            msgId: 'd2',
            fromAgentId: 'lead',
            to: 'main',
            kind: 'decision',
            relatedTaskId: 'task-456',
            content: 'approved',
            createdAt: now,
          },
        ],
      },
    } as never);

    mountSidebar('/dashboard');

    expect(screen.queryByText('Task task-456')).not.toBeInTheDocument();
  });

  it('renders chat approval blockers and navigates to target chat session', async () => {
    setupSidebarState();
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      sessionMetasResource: {
        status: 'ready',
        data: [
          { key: 'agent:main:main', displayName: 'agent:main:main' },
          { key: 'agent:analytics:main', displayName: 'agent:analytics:main' },
        ],
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      loadedSessions: {
        'agent:main:main': createSessionRecord({ ready: true }),
        'agent:analytics:main': createSessionRecord({ ready: true }),
      },
      pendingApprovalsBySession: {
        'agent:analytics:main': [
          {
            id: 'approval-chat-1',
            sessionKey: 'agent:analytics:main',
            runId: 'run-chat-1',
            toolName: 'browser.fetch',
            createdAtMs: Date.now(),
          },
        ],
      },
    } as never);

    mountSidebar('/dashboard');

    expect(screen.getByText(/Approval Blocker · browser.fetch/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Approval Blocker · browser.fetch/i }));
    await waitFor(() => {
      expect(screen.getByTestId('location-echo')).toHaveTextContent('/?session=agent%3Aanalytics%3Amain');
    });
  });

  it('chat approval blocker cache should not depend on session displayName fallback', () => {
    setupSidebarState();
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      sessionMetasResource: {
        status: 'ready',
        data: [
          { key: 'agent:main:main', displayName: 'MatchaClaw Runtime Host' },
        ],
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      loadedSessions: {
        'agent:main:main': createSessionRecord({ ready: true, label: null }),
      },
      pendingApprovalsBySession: {
        'agent:main:main': [
          {
            id: 'approval-chat-1',
            sessionKey: 'agent:main:main',
            runId: 'run-chat-1',
            toolName: 'browser.fetch',
            createdAtMs: Date.now(),
          },
        ],
      },
    } as never);

    mountSidebar('/dashboard');

    expect(screen.queryByText('MatchaClaw Runtime Host')).not.toBeInTheDocument();
    expect(screen.getByText(/Approval Blocker · browser.fetch/i)).toBeInTheDocument();
  });
});


