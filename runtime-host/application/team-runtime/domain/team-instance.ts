import type { RuntimeEndpointRef, SessionIdentity } from '../../agent-runtime/contracts/runtime-address';
import type { TeamGraphDefinition } from '../graph';
import type { TeamRoleSessionBinding, TeamRunStatus } from './team-run';

export interface TeamManagedAgentConfigRestore {
  readonly entryExisted: boolean;
  readonly entry?: Record<string, unknown>;
}

export interface TeamManagedAgentRecord {
  readonly teamId: string;
  readonly roleId: string;
  readonly agentId: string;
  readonly displayName: string;
  readonly workspace: string;
  readonly endpoint: RuntimeEndpointRef;
  readonly model?: string;
  readonly lifecycle?: 'team-owned' | 'external';
  readonly configRestore?: TeamManagedAgentConfigRestore;
}

export interface TeamInstanceRunRecord {
  readonly teamId: string;
  readonly runId: string;
  readonly status: TeamRunStatus;
  readonly revision: number;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly sourcePath: string;
  readonly sessions: readonly TeamRoleSessionBinding[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface TeamInstance {
  readonly teamId: string;
  readonly teamSkillName: string;
  readonly teamSkillVersion: string;
  readonly packagePath: string;
  readonly sourcePath: string;
  readonly sourceType?: 'teamskill' | 'manual';
  readonly managedAgents: readonly TeamManagedAgentRecord[];
  readonly graphTemplate?: TeamGraphDefinition | null;
  readonly runs: readonly TeamInstanceRunRecord[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

export function buildTeamRoleSessionKey(runId: string, roleId: string, agentId: string): string {
  return `agent:${agentId}:team-role:${runId}:${roleId}`;
}

export function buildTeamRoleSessionBinding(input: {
  readonly teamId: string;
  readonly runId: string;
  readonly roleId: string;
  readonly agentId: string;
  readonly endpoint: RuntimeEndpointRef;
}): TeamRoleSessionBinding {
  const sessionIdentity: SessionIdentity = {
    endpoint: input.endpoint,
    agentId: input.agentId,
    sessionKey: buildTeamRoleSessionKey(input.runId, input.roleId, input.agentId),
  };
  return {
    teamId: input.teamId,
    runId: input.runId,
    roleId: input.roleId,
    agentId: input.agentId,
    sessionIdentity,
    sessionKey: sessionIdentity.sessionKey,
  };
}

export function buildTeamRoleSessionBindingsFromManagedAgents(input: {
  readonly teamId: string;
  readonly runId: string;
  readonly managedAgents: readonly TeamManagedAgentRecord[];
}): TeamRoleSessionBinding[] {
  return input.managedAgents.map((agent) => buildTeamRoleSessionBinding({
    teamId: input.teamId,
    runId: input.runId,
    roleId: agent.roleId,
    agentId: agent.agentId,
    endpoint: agent.endpoint,
  }));
}

export function collectTeamManagedAgentIds(managedAgents: readonly TeamManagedAgentRecord[]): string[] {
  return Array.from(new Set(managedAgents.filter((agent) => agent.lifecycle !== 'external').map((agent) => agent.agentId)));
}
