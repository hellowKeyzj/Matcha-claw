import { beforeEach, describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TeamsPage } from '@/pages/Teams';
import { useTeamsStore } from '@/stores/teams';
import { useSubagentsStore } from '@/stores/subagents';
import i18n from '@/i18n';

vi.mock('@/lib/team/controller', () => ({
  TEAM_CONTROLLER_ID: 'team-controller',
  TEAM_CONTROLLER_NAME: 'team-controller',
  TEAM_CONTROLLER_EMOJI: '🧭',
  TEAM_CONTROLLER_PROMPT_STORAGE_KEY: 'clawx.teamControllerPromptTemplate',
  DEFAULT_TEAM_CONTROLLER_PROMPT: 'controller prompt',
  checkTeamControllerReadiness: vi.fn().mockResolvedValue({
    ready: true,
    exists: true,
    missingFiles: [],
    agentsMdNonEmpty: true,
  }),
}));

describe('teams page', () => {
  beforeEach(() => {
    i18n.changeLanguage('en');
    useTeamsStore.setState({
      teams: [
        {
          id: 'team-1',
          name: 'Design Team',
          controllerId: 'main',
          memberIds: ['main', 'agent-alpha'],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      activeTeamId: null,
      teamContexts: {},
      teamReports: {},
      teamMessagesById: {},
      teamSessionKeys: {},
      teamPhaseById: {},
      agentLatestOutput: {},
    });
    useSubagentsStore.setState({
      agents: [
        {
          id: 'agent-alpha',
          name: 'Alpha',
          workspace: '/home/dev/.openclaw/workspace-subagents/alpha',
          model: 'gpt-4o-mini',
          identityEmoji: '??',
          isDefault: false,
        },
      ],
      managedAgentId: null,
    });
  });

  it('renders workspace header and lists', async () => {
    render(
      <MemoryRouter>
        <TeamsPage />
      </MemoryRouter>
    );

    expect(await screen.findByRole('heading', { name: 'Agents Workspace' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'New Team' })).toBeInTheDocument();
    expect(await screen.findByText('Design Team')).toBeInTheDocument();
    expect(await screen.findByText('Alpha')).toBeInTheDocument();
  });

  it('creates a new team when clicking new team', async () => {
    useTeamsStore.setState({
      teams: [],
      activeTeamId: null,
      teamContexts: {},
      teamReports: {},
      teamMessagesById: {},
      teamSessionKeys: {},
      teamPhaseById: {},
      agentLatestOutput: {},
    });

    render(
      <MemoryRouter>
        <TeamsPage />
      </MemoryRouter>
    );

    fireEvent.click(await screen.findByRole('button', { name: 'New Team' }));
    fireEvent.change(await screen.findByLabelText('Team Name'), { target: { value: 'Growth Team' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Create' }));

    const state = useTeamsStore.getState();
    expect(state.teams.length).toBe(1);
    expect(state.activeTeamId).toBeTruthy();
    expect(state.teams[0].name).toBe('Growth Team');
    expect(state.teams[0].controllerId).toBe('agent-alpha');
    expect(state.teams[0].memberIds).toEqual(['agent-alpha']);
  });

  it('opens subagent manage when clicking an agent card', async () => {
    render(
      <MemoryRouter>
        <TeamsPage />
      </MemoryRouter>
    );

    fireEvent.click(await screen.findByText('Alpha'));

    expect(useSubagentsStore.getState().managedAgentId).toBe('agent-alpha');
  });
});
