import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { Sidebar } from '@/components/layout/Sidebar';
import { useChatStore } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import { useSettingsStore } from '@/stores/settings';
import { useSubagentsStore } from '@/stores/subagents';
import { useTeamsStore } from '@/stores/teams';
import { useTaskCenterStore } from '@/stores/task-center-store';
import i18n from '@/i18n';

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
    loading: false,
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
    blockedQueue: [],
    init: vi.fn().mockResolvedValue(undefined),
    refreshTasks: vi.fn().mockResolvedValue(undefined),
    resumeBlockedTask: vi.fn().mockResolvedValue(undefined),
    closeBlockedDialog: vi.fn(),
    handleGatewayNotification: vi.fn(),
  } as never);
  i18n.changeLanguage('en');
}

describe('sidebar chat nav', () => {
  it('from non-chat routes, clicking chat only navigates and does not create new session', () => {
    setupSidebarState();
    const newSession = vi.fn();
    useChatStore.setState({
      sessions: [{ key: 'agent:main:main' }],
      currentSessionKey: 'agent:main:main',
      sessionLabels: {},
      sessionLastActivity: {},
      messages: [{ role: 'user', content: 'existing' }],
      newSession,
      switchSession: vi.fn(),
      deleteSession: vi.fn(),
    } as never);

    mountSidebar('/tasks');

    fireEvent.click(screen.getByRole('button', { name: 'New Chat' }));

    expect(newSession).not.toHaveBeenCalled();
    expect(screen.getByTestId('location-echo')).toHaveTextContent('/');
  });

  it('on chat route, clicking chat creates new session when current session has messages', () => {
    setupSidebarState();
    const newSession = vi.fn();
    useChatStore.setState({
      sessions: [{ key: 'agent:main:main' }],
      currentSessionKey: 'agent:main:main',
      sessionLabels: {},
      sessionLastActivity: {},
      messages: [{ role: 'user', content: 'existing' }],
      newSession,
      switchSession: vi.fn(),
      deleteSession: vi.fn(),
    } as never);

    mountSidebar('/');

    fireEvent.click(screen.getByRole('button', { name: 'New Chat' }));

    expect(newSession).toHaveBeenCalledTimes(1);
  });

  it('renders pending question cards and navigates to team detail', () => {
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
    expect(screen.getByTestId('location-echo')).toHaveTextContent('/teams/team-1');
  });

  it('renders task-manager blockers and navigates to tasks page', () => {
    setupSidebarState();
    useTaskCenterStore.setState({
      blockedQueue: [
        {
          taskId: 'task-456',
          confirmId: 'confirm-1',
          prompt: 'Need manual approval',
          type: 'waiting_approval',
          inputMode: 'decision',
        },
      ],
      tasks: [
        {
          id: 'task-456',
          goal: 'Deploy release pipeline',
          status: 'waiting_approval',
          progress: 0.5,
          created_at: 100,
          updated_at: 200,
        },
      ],
    } as never);

    mountSidebar('/dashboard');

    expect(screen.getAllByText('Task Center').length).toBeGreaterThan(0);
    expect(screen.getByText(/Approval Blocker/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Deploy release pipeline/i }));
    expect(screen.getByTestId('location-echo')).toHaveTextContent('/tasks');
  });

  it('renders chat approval blockers and navigates to target chat session', () => {
    setupSidebarState();
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      sessions: [
        { key: 'agent:main:main', displayName: 'agent:main:main' },
        { key: 'agent:analytics:main', displayName: 'agent:analytics:main' },
      ],
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
    expect(screen.getByTestId('location-echo')).toHaveTextContent('/?session=agent%3Aanalytics%3Amain');
  });
});
