import { useTeamsStore } from './store';

export { isTeamApprovalActionable, selectTeamApprovalRunEligibility, type TeamApprovalRunEligibility } from './store';

type TeamApprovalProjection = Pick<ReturnType<typeof useTeamsStore.getState>,
  'teams' | 'runIdsByTeamId' | 'runSnapshotsByRunId' | 'approvalsByRunId'>;

export function useTeamApprovalProjection<T>(selector: (state: TeamApprovalProjection) => T): T {
  return useTeamsStore(selector);
}
