import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TeamsBackgroundOrchestrator } from '@/lib/team/background-orchestrator';
import { useGatewayStore } from '@/stores/gateway';
import { useTeamsRunnerStore } from '@/stores/teams-runner';
import { useTeamsStore } from '@/stores/teams';

describe('teams background orchestrator', () => {
  beforeEach(() => {
    useGatewayStore.setState({
      status: { state: 'running', port: 18789 },
    } as never);

    useTeamsRunnerStore.setState({
      daemonRunning: false,
      enabledByTeamId: { 'team-1': true },
      activeAgentIdsByTeamId: {},
      activeTaskByAgentByTeamId: {},
      lastErrorByTeamId: {},
    });
  });

  it('initializes runtime without relying on TeamChat page mount', async () => {
    const initRuntime = vi.fn(async (teamId: string) => {
      useTeamsStore.setState((state) => ({
        runMetaByTeamId: {
          ...state.runMetaByTeamId,
          [teamId]: {
            teamId,
            leadAgentId: 'main',
            status: 'active',
            revision: 1,
            createdAt: 1,
            updatedAt: 1,
          },
        },
      }));
    });
    const refreshSnapshot = vi.fn().mockResolvedValue(undefined);
    const pullMailbox = vi.fn().mockResolvedValue(undefined);

    useTeamsStore.setState({
      teams: [
        {
          id: 'team-1',
          name: 'Team 1',
          leadAgentId: 'main',
          memberIds: [],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      activeTeamId: null,
      runMetaByTeamId: {},
      tasksByTeamId: { 'team-1': [] },
      mailboxByTeamId: { 'team-1': [] },
      mailboxCursorByTeamId: {},
      eventsByTeamId: {},
      loadingByTeamId: {},
      errorByTeamId: {},
      createTeam: vi.fn(),
      setActiveTeam: vi.fn(),
      deleteTeam: vi.fn(),
      initRuntime,
      refreshSnapshot,
      planUpsert: vi.fn().mockResolvedValue(undefined),
      claimNext: vi.fn().mockResolvedValue(null),
      heartbeat: vi.fn().mockResolvedValue(true),
      updateTaskStatus: vi.fn().mockResolvedValue(undefined),
      postMailbox: vi.fn().mockResolvedValue(undefined),
      pullMailbox,
      releaseClaim: vi.fn().mockResolvedValue(undefined),
    } as never);

    const orchestrator = new TeamsBackgroundOrchestrator();
    await (orchestrator as unknown as { tick: () => Promise<void> }).tick();

    expect(initRuntime).toHaveBeenCalledWith('team-1');
    expect(refreshSnapshot).toHaveBeenCalledWith('team-1');
    expect(pullMailbox).toHaveBeenCalledWith('team-1', 200);
  });
});
