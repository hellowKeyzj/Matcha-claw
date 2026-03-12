import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useTeamsStore } from '@/stores/teams';
import { useTeamsRunnerStore } from '@/stores/teams-runner';
import { TeamChat } from '@/pages/Teams/TeamChat';
import i18n from '@/i18n';

describe('team chat', () => {
  beforeEach(() => {
    i18n.changeLanguage('en');
    localStorage.removeItem('teams-runtime-store');
    localStorage.removeItem('teams-runner-store');

    useTeamsRunnerStore.setState({
      daemonRunning: true,
      enabledByTeamId: { 'team-1': true },
      activeAgentIdsByTeamId: { 'team-1': [] },
      activeTaskByAgentByTeamId: { 'team-1': {} },
      lastErrorByTeamId: {},
    });

    useTeamsStore.setState({
      teams: [
        {
          id: 'team-1',
          name: 'Team 1',
          leadAgentId: 'a1',
          memberIds: ['a1', 'a2'],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      activeTeamId: 'team-1',
      runMetaByTeamId: {
        'team-1': {
          teamId: 'team-1',
          leadAgentId: 'a1',
          status: 'active',
          revision: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      },
      tasksByTeamId: {
        'team-1': [
          {
            taskId: 'task-1',
            title: 'Implement runtime',
            instruction: 'Implement runtime',
            dependsOn: [],
            status: 'todo',
            attempt: 0,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      },
      mailboxByTeamId: {
        'team-1': [
          {
            msgId: 'm1',
            fromAgentId: 'a1',
            to: 'broadcast',
            kind: 'question',
            content: 'Need decision',
            createdAt: 1,
          },
        ],
      },
      mailboxCursorByTeamId: { 'team-1': '1:m1' },
      eventsByTeamId: { 'team-1': [] },
      loadingByTeamId: { 'team-1': false },
      errorByTeamId: { 'team-1': undefined },
      setActiveTeam: vi.fn(),
      initRuntime: vi.fn().mockResolvedValue(undefined),
      refreshSnapshot: vi.fn().mockResolvedValue(undefined),
      planUpsert: vi.fn().mockResolvedValue(undefined),
      claimNext: vi.fn().mockResolvedValue(null),
      heartbeat: vi.fn().mockResolvedValue(true),
      updateTaskStatus: vi.fn().mockResolvedValue(undefined),
      releaseClaim: vi.fn().mockResolvedValue(undefined),
      postMailbox: vi.fn().mockResolvedValue(undefined),
      pullMailbox: vi.fn().mockResolvedValue(undefined),
    } as never);
  });

  it('renders board, mailbox and agents panes', async () => {
    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Task Board')).toBeInTheDocument();
    expect(screen.getByText('Mailbox')).toBeInTheDocument();
    expect(screen.getByText('Agents')).toBeInTheDocument();
    expect(screen.getByText('Implement runtime')).toBeInTheDocument();
    expect(screen.getByText('Need decision')).toBeInTheDocument();
  });

  it('claims next task from board action', async () => {
    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Claim Next' }));

    await waitFor(() => {
      expect(useTeamsStore.getState().claimNext).toHaveBeenCalledWith('team-1', 'a1', 'agent:a1:team:team-1:exec');
    });
  });

  it('posts mailbox message', async () => {
    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>,
    );

    fireEvent.change(await screen.findByLabelText('Message'), { target: { value: 'Please review' } });
    fireEvent.click(screen.getByRole('button', { name: 'Post Message' }));

    await waitFor(() => {
      expect(useTeamsStore.getState().postMailbox).toHaveBeenCalledTimes(1);
      expect(useTeamsStore.getState().postMailbox).toHaveBeenCalledWith(
        'team-1',
        expect.objectContaining({
          fromAgentId: 'a1',
          to: 'broadcast',
          kind: 'question',
          content: 'Please review',
        }),
      );
    });
  });
});
