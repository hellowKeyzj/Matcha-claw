import { useTeamsStore } from './store';
import type { TeamMeta } from './types/team';
import type { TeamRoleBindingRecord, TeamRunListItem } from './services/team-runtime-client';
import type { TeamDesignRecord } from '@/types/team-design';

export interface TeamSessionProjection {
  teams: TeamMeta[];
  rolesByTeamId: Record<string, TeamRoleBindingRecord[]>;
  runListByTeamId: Record<string, TeamRunListItem[]>;
  designByRunId: Record<string, TeamDesignRecord | undefined>;
}

const EMPTY_TEAM_SESSION_ROLES: readonly TeamRoleBindingRecord[] = [];

export function useTeamSessionProjection<T>(selector: (state: TeamSessionProjection) => T): T {
  return useTeamsStore(selector);
}

export function selectTeamSessionRoles(state: TeamSessionProjection, teamId: string): readonly TeamRoleBindingRecord[] {
  const team = state.teams.find((team) => team.id === teamId);
  if (!team) return EMPTY_TEAM_SESSION_ROLES;
  const runId = team.activeRunId;
  const roles = runId
    ? state.designByRunId[runId]?.snapshot?.roles
      ?? state.runListByTeamId[team.id]?.find((run) => run.runId === runId)?.sessions
      ?? state.rolesByTeamId[team.id]?.filter((role) => role.runId === runId)
    : state.rolesByTeamId[team.id];
  return roles ?? EMPTY_TEAM_SESSION_ROLES;
}

export function readTeamSessionRoles(teamId: string): readonly TeamRoleBindingRecord[] {
  return selectTeamSessionRoles(useTeamsStore.getState(), teamId);
}
