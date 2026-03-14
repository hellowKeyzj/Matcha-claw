import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/features/teams/api/runtime-client', () => ({
  teamInit: vi.fn(),
  teamSnapshot: vi.fn(),
  teamPlanUpsert: vi.fn(),
  teamClaimNext: vi.fn(),
  teamHeartbeat: vi.fn(),
  teamTaskUpdate: vi.fn(),
  teamMailboxPost: vi.fn(),
  teamMailboxPull: vi.fn(),
  teamReleaseClaim: vi.fn(),
}));

import { useTeamsStore } from '@/stores/teams';
import {
  teamClaimNext,
  teamHeartbeat,
  teamInit,
  teamMailboxPost,
  teamMailboxPull,
  teamPlanUpsert,
  teamReleaseClaim,
  teamSnapshot,
  teamTaskUpdate,
} from '@/features/teams/api/runtime-client';

describe('teams store', () => {
  beforeEach(() => {
    localStorage.removeItem('teams-runtime-store');

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
    });

    vi.mocked(teamInit).mockResolvedValue({
      runtimeRoot: '/tmp/team-runtime/team-1',
      run: {
        teamId: 'team-1',
        leadAgentId: 'lead',
        status: 'active',
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    });
    vi.mocked(teamSnapshot).mockResolvedValue({
      run: {
        teamId: 'team-1',
        leadAgentId: 'lead',
        status: 'active',
        revision: 2,
        createdAt: 1,
        updatedAt: 2,
      },
      tasks: [
        {
          taskId: 'task-1',
          title: 'Task 1',
          instruction: 'Do task 1',
          dependsOn: [],
          status: 'todo',
          attempt: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      mailbox: {
        messages: [
          {
            msgId: 'm1',
            fromAgentId: 'lead',
            to: 'broadcast',
            kind: 'question',
            content: 'hello',
            createdAt: 1,
          },
        ],
        nextCursor: '1:m1',
      },
      events: [{ id: 'e1' }],
    });
    vi.mocked(teamPlanUpsert).mockResolvedValue({ tasks: [] });
    vi.mocked(teamClaimNext).mockResolvedValue({ task: null });
    vi.mocked(teamHeartbeat).mockResolvedValue({ ok: true });
    vi.mocked(teamTaskUpdate).mockResolvedValue({
      task: {
        taskId: 'task-1',
        title: 'Task 1',
        instruction: 'Do task 1',
        dependsOn: [],
        status: 'done',
        attempt: 1,
        createdAt: 1,
        updatedAt: 3,
      },
    });
    vi.mocked(teamMailboxPost).mockResolvedValue({
      created: true,
      message: {
        msgId: 'm2',
        fromAgentId: 'lead',
        to: 'broadcast',
        kind: 'question',
        content: 'new',
        createdAt: 2,
      },
    });
    vi.mocked(teamMailboxPull).mockResolvedValue({ messages: [], nextCursor: '1:m1' });
    vi.mocked(teamReleaseClaim).mockResolvedValue({ ok: true });
  });

  it('creates and selects team with deduplicated members', () => {
    const id = useTeamsStore.getState().createTeam({
      name: 'Team A',
      leadAgentId: 'lead',
      memberIds: ['lead', 'dev', 'dev'],
    });

    const state = useTeamsStore.getState();
    expect(state.activeTeamId).toBe(id);
    expect(state.teams).toHaveLength(1);
    expect(state.teams[0]?.memberIds).toEqual(['lead', 'dev']);
  });

  it('initializes runtime and hydrates snapshot', async () => {
    useTeamsStore.setState({
      teams: [
        {
          id: 'team-1',
          name: 'Team A',
          leadAgentId: 'lead',
          memberIds: ['lead', 'dev'],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });

    await useTeamsStore.getState().initRuntime('team-1');

    const state = useTeamsStore.getState();
    expect(teamInit).toHaveBeenCalledWith({ teamId: 'team-1', leadAgentId: 'lead' });
    expect(teamSnapshot).toHaveBeenCalled();
    expect(state.runMetaByTeamId['team-1']?.revision).toBe(2);
    expect(state.tasksByTeamId['team-1']).toHaveLength(1);
    expect(state.mailboxByTeamId['team-1']?.[0]?.msgId).toBe('m1');
    expect(state.mailboxCursorByTeamId['team-1']).toBe('1:m1');
  });
});
