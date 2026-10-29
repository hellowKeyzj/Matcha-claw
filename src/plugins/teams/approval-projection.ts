import { useTeamsStore } from './store';

type TeamApprovalProjection = Pick<ReturnType<typeof useTeamsStore.getState>,
  'teams' | 'approvalsByTeamId' | 'setActiveTeam'>;

export function useTeamApprovalProjection<T>(selector: (state: TeamApprovalProjection) => T): T {
  return useTeamsStore(selector);
}
