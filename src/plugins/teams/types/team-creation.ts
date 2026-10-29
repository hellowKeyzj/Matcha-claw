import type { AgentScope, RuntimeInstanceScope } from '@/types/desktop/runtime-address';
import type { OrganizationProvisionProgress, TeamCreationFailure } from '@/types/call-log/organization';

export interface TeamSkillPackage {
  selectionId: string;
  name: string;
  version: string;
  kind: 'team-skill';
  description: string;
}

export interface ManualTeamMemberProvisionRecord {
  agentId: string;
  agentName: string;
  workspace: string;
  roleId: string;
  skills: string[];
  tools: string[];
  model?: string;
  isLeader: boolean;
}

export interface ManualTeamProvisionRecord {
  name: string;
  description: string;
  version: string;
  members: ManualTeamMemberProvisionRecord[];
}

export interface TeamSkillCandidate {
  runtimeScope: RuntimeInstanceScope;
  displayName: string;
  packagePath: string;
  teamSkillPackage: TeamSkillPackage;
}

export interface ManualTeamCandidate {
  runtimeScope: AgentScope;
  displayName: string;
  manualTeam: ManualTeamProvisionRecord;
}

export type TeamSkillCreationPlan =
  | { action: 'create' }
  | { action: 'open_existing'; teamId: string }
  | { action: 'replace_required'; teamId: string; currentVersion: string; incomingVersion: string };

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
