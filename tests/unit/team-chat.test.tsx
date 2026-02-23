import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useSubagentsStore } from '@/stores/subagents';
import { useTeamsStore } from '@/stores/teams';
import { TeamChat } from '@/pages/Teams/TeamChat';
import i18n from '@/i18n';

describe('team chat', () => {
  beforeEach(() => {
    i18n.changeLanguage('en');
    useTeamsStore.setState({
      teams: [
        {
          id: 'team-1',
          name: 'Team 1',
          controllerId: 'a1',
          memberIds: ['a1'],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      activeTeamId: 'team-1',
      teamContexts: {},
      teamReports: {},
      teamMessagesById: {
        'team-1': [
          {
            id: 'm1',
            role: 'assistant',
            agentId: 'a1',
            content: 'PLAN:\\n- step',
            kind: 'plan',
            timestamp: 1,
          },
          {
            id: 'm2',
            role: 'assistant',
            agentId: 'a1',
            content: 'REPORT: {\"status\":\"done\"}',
            kind: 'report',
            timestamp: 2,
          },
        ],
      },
      teamSessionKeys: { 'team-1': { a1: 'agent:a1:team:team-1' } },
      teamPhaseById: { 'team-1': 'discussion' },
      agentLatestOutput: {},
    });
    useSubagentsStore.setState({
      agents: [
        {
          id: 'a1',
          name: 'Agent A',
          workspace: '/workspace/a1',
          model: 'gpt-4o-mini',
          isDefault: false,
        },
      ],
    });
  });

  it('renders team chat input', () => {
    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>
    );

    expect(screen.getByTitle('Send')).toBeInTheDocument();
  });

  it('renders PLAN and REPORT badges', () => {
    render(
      <MemoryRouter>
        <TeamChat teamId="team-1" />
      </MemoryRouter>
    );

    expect(screen.getByText('PLAN')).toBeInTheDocument();
    expect(screen.getByText('REPORT')).toBeInTheDocument();
  });

  it('shows binding warning when members are missing', async () => {
    useTeamsStore.setState({
      teams: [
        {
          id: 'team-2',
          name: 'Team 2',
          controllerId: 'a1',
          memberIds: ['a1', 'missing-agent'],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      activeTeamId: 'team-2',
      teamMessagesById: {},
      teamSessionKeys: {},
      teamPhaseById: { 'team-2': 'discussion' },
      agentLatestOutput: {},
    });

    render(
      <MemoryRouter>
        <TeamChat teamId="team-2" />
      </MemoryRouter>
    );

    expect(await screen.findByText(/Missing team members/i)).toBeInTheDocument();
    expect(screen.getAllByText(/missing-agent/).length).toBeGreaterThan(0);
  });
});
