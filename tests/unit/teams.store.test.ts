import { describe, it, expect, beforeEach } from 'vitest';
import { useTeamsStore } from '@/stores/teams';

describe('teams store', () => {
  beforeEach(() => {
    useTeamsStore.setState({ teams: [], activeTeamId: null, teamContexts: {}, teamReports: {}, teamSessionKeys: {} });
  });

  it('creates and selects a team', () => {
    const { createTeam } = useTeamsStore.getState();
    const id = createTeam({ name: 'Team A', controllerId: 'main', memberIds: ['main'] });
    expect(useTeamsStore.getState().activeTeamId).toBe(id);
  });
});
