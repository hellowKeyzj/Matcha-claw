import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TeamsPage } from '@/pages/Teams';
import { useTeamsStore } from '@/stores/teams';
import { useSubagentsStore } from '@/stores/subagents';
import i18n from '@/i18n';

describe('teams page', () => {
  beforeEach(() => {
    i18n.changeLanguage('en');
    localStorage.removeItem('teams-runtime-store');

    useSubagentsStore.setState({
      agents: [
        {
          id: 'agent-alpha',
          name: 'Alpha',
          workspace: '/home/dev/.openclaw/workspace-subagents/alpha',
          model: 'gpt-4o-mini',
          identityEmoji: '🤖',
          isDefault: false,
        },
        {
          id: 'agent-beta',
          name: 'Beta',
          workspace: '/home/dev/.openclaw/workspace-subagents/beta',
          model: 'gpt-4o-mini',
          identityEmoji: '🧠',
          isDefault: false,
        },
      ],
      loadAgents: vi.fn().mockResolvedValue(undefined),
      managedAgentId: null,
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
      initRuntime: vi.fn().mockResolvedValue(undefined),
    } as never);
  });

  it('renders create form and team list', async () => {
    useTeamsStore.setState({
      teams: [
        {
          id: 'team-1',
          name: 'Design Team',
          leadAgentId: 'agent-alpha',
          memberIds: ['agent-alpha', 'agent-beta'],
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

  it('creates a new team and initializes runtime', async () => {
    const initRuntimeMock = vi.fn().mockResolvedValue(undefined);
    useTeamsStore.setState({ initRuntime: initRuntimeMock } as never);

    render(
      <MemoryRouter>
        <TeamsPage />
      </MemoryRouter>,
    );

    fireEvent.change(await screen.findByLabelText('Team Name'), { target: { value: 'Growth Team' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Team' }));

    await waitFor(() => {
      const state = useTeamsStore.getState();
      expect(state.teams.length).toBe(1);
      expect(state.activeTeamId).toBe(state.teams[0]?.id);
      expect(state.teams[0]?.name).toBe('Growth Team');
      expect(state.teams[0]?.leadAgentId).toBe('agent-alpha');
      expect(state.teams[0]?.memberIds).toContain('agent-alpha');
    });

    expect(initRuntimeMock).toHaveBeenCalledTimes(1);
  });

  it('deletes an existing team', async () => {
    useTeamsStore.setState({
      teams: [
        {
          id: 'team-1',
          name: 'Design Team',
          leadAgentId: 'agent-alpha',
          memberIds: ['agent-alpha'],
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
