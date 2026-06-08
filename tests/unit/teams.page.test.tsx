import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TeamsPage } from '@/pages/Teams';
import { useGatewayStore } from '@/stores/gateway';
import { useTeamsStore } from '@/stores/teams';
import { useSubagentsStore } from '@/stores/subagents';
import i18n from '@/i18n';

const runtimeInstanceScope = {
  kind: 'runtime-instance' as const,
  endpoint: {
    kind: 'native-runtime' as const,
    runtimeAdapterId: 'openclaw',
    runtimeInstanceId: 'local',
  },
};

vi.mock('@/lib/host-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/host-api')>();
  return {
    ...actual,
    resolveSingleCapabilityScope: vi.fn(async () => runtimeInstanceScope),
  };
});

describe('teams page', () => {
  const loadAgentsMock = vi.fn().mockResolvedValue(undefined);
  const agents = [
    {
      id: 'agent-alpha',
      name: 'Alpha',
      workspace: '/home/dev/.openclaw/workspace-subagents/alpha',
      model: 'gpt-4o-mini',
      avatarSeed: 'agent:agent-alpha',
      avatarStyle: 'pixelArt',
      isDefault: false,
    },
    {
      id: 'agent-beta',
      name: 'Beta',
      workspace: '/home/dev/.openclaw/workspace-subagents/beta',
      model: 'gpt-4o-mini',
      avatarSeed: 'agent:agent-beta',
      avatarStyle: 'bottts',
      isDefault: false,
    },
  ];

  beforeEach(() => {
    i18n.changeLanguage('en');
    localStorage.removeItem('teams-runtime-store');
    loadAgentsMock.mockClear();

    useGatewayStore.setState({
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
        updatedAt: 1,
      },
      health: null,
      isInitialized: true,
      lastError: null,
    });

    useSubagentsStore.setState({
      agents,
      agentsResource: {
        status: 'ready',
        data: agents,
        error: null,
        loadedAt: 1,
        requestId: 0,
        hasLoadedOnce: true,
      },
      loadAgents: loadAgentsMock,
      managedAgentId: null,
    } as never);

    useTeamsStore.setState({
      teams: [],
      activeTeamId: null,
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
      ensureRunCreated: vi.fn().mockResolvedValue(undefined),
      startRun: vi.fn().mockResolvedValue(undefined),
      refreshSnapshot: vi.fn().mockResolvedValue(undefined),
    } as never);
  });

  it('gateway 恢复到 running 后才会刷新智能体列表', async () => {
    render(
      <MemoryRouter>
        <TeamsPage />
      </MemoryRouter>,
    );

    expect(loadAgentsMock).not.toHaveBeenCalled();

    act(() => {
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
          updatedAt: 2,
        },
      });
    });

    await waitFor(() => {
      expect(loadAgentsMock).toHaveBeenCalledTimes(1);
    });
  });

  it('启动阶段且无本地 agent 时显示等待提示', async () => {
    useGatewayStore.setState({
      status: {
        processState: 'starting',
        port: 18789,
        gatewayReady: false,
        healthSummary: 'degraded',
        transportState: 'reconnecting',
        portReachable: false,
        diagnostics: {
          consecutiveHeartbeatMisses: 0,
          consecutiveRpcFailures: 0,
        },
        updatedAt: 1,
      },
      health: null,
      isInitialized: false,
      lastError: null,
    });
    useSubagentsStore.setState({
      agents: [],
      agentsResource: {
        status: 'idle',
        data: [],
        error: null,
        loadedAt: null,
        requestId: 0,
        hasLoadedOnce: false,
      },
      loadAgents: loadAgentsMock,
      managedAgentId: null,
    } as never);

    render(
      <MemoryRouter>
        <TeamsPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Waiting for the gateway to load agents...')).toBeInTheDocument();
    expect(loadAgentsMock).not.toHaveBeenCalled();
  });

  it('renders create form and team list', async () => {
    useTeamsStore.setState({
      teams: [
        {
          id: 'team-1',
          name: 'Design Team',
          leadAgentId: 'agent-alpha',
          memberIds: ['agent-alpha', 'agent-beta'],
          packagePath: '.tmp/team-skill',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    } as never);

    render(
      <MemoryRouter>
        <TeamsPage />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'Agents Workspace' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Create Team' })).toBeInTheDocument();
    expect(screen.getByText('Design Team')).toBeInTheDocument();
    expect(screen.getByText(/Lead:\s*agent-alpha/)).toBeInTheDocument();
  });

  it('creates a new team without starting runtime', async () => {
    const startRunMock = vi.fn().mockResolvedValue(undefined);
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
        updatedAt: 2,
      },
    });
    useTeamsStore.setState({ startRun: startRunMock } as never);

    render(
      <MemoryRouter>
        <TeamsPage />
      </MemoryRouter>,
    );

    fireEvent.change(await screen.findByLabelText('Team Name'), { target: { value: 'Growth Team' } });
    fireEvent.change(screen.getByLabelText('TeamSkill Package Path'), { target: { value: '.tmp/team-skill' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Team' }));

    await waitFor(() => {
      const state = useTeamsStore.getState();
      expect(state.teams.length).toBe(1);
      expect(state.activeTeamId).toBe(state.teams[0]?.id);
      expect(state.teams[0]?.name).toBe('Growth Team');
      expect(state.teams[0]?.leadAgentId).toBe('agent-alpha');
      expect(state.teams[0]?.memberIds).toContain('agent-alpha');
      expect(state.teams[0]?.packagePath).toBe('.tmp/team-skill');
    });

    expect(startRunMock).not.toHaveBeenCalled();
  });

  it('deletes an existing team', async () => {
    useTeamsStore.setState({
      teams: [
        {
          id: 'team-1',
          name: 'Design Team',
          leadAgentId: 'agent-alpha',
          memberIds: ['agent-alpha'],
          packagePath: '.tmp/team-skill',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      activeTeamId: 'team-1',
    } as never);

    render(
      <MemoryRouter>
        <TeamsPage />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(useTeamsStore.getState().teams).toHaveLength(0);
      expect(useTeamsStore.getState().activeTeamId).toBeNull();
    });
  });
});
