import { useTeamsStore } from './store';

type TeamSessionNavigation = Pick<ReturnType<typeof useTeamsStore.getState>,
  'createRun' | 'setActiveRun' | 'syncRunList' | 'refreshSnapshot'>;

export function useTeamSessionNavigation<T>(selector: (state: TeamSessionNavigation) => T): T {
  return useTeamsStore(selector);
}
