import type { ManualTeamCandidate } from '@/stores/teams';
import type { OrganizationProvisionProgress, TeamCreationFailure } from './call-log/organization';

export interface TeamCreationObserver {
  onFailure?: (failure: TeamCreationFailure) => void;
}

export type ManualTeamCreationPhase =
  | 'submitting'
  | OrganizationProvisionProgress['stage']
  | 'initializing_sessions'
  | 'loading_team';

export type ManualTeamCreationProgress = OrganizationProvisionProgress & {
  callId: string;
  revision: number;
};

type ManualTeamCreationSnapshot = {
  teamId: string | null;
  candidate: ManualTeamCandidate;
  startedAt: number;
  phase: ManualTeamCreationPhase;
  preparationObserved: boolean;
  progress: ManualTeamCreationProgress | null;
  failure: TeamCreationFailure | null;
};

export type ManualTeamCreation = ManualTeamCreationSnapshot & (
  | { status: 'running'; cleanup: 'none'; endedAt: null }
  | { status: 'cleaning_up'; cleanup: 'none'; endedAt: null }
  | { status: 'failed'; cleanup: 'confirmed'; endedAt: number }
  | { status: 'unconfirmed'; cleanup: 'none' | 'unknown'; endedAt: number }
);
