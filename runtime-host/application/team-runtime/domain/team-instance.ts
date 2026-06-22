import type { RuntimeEndpointRef, SessionIdentity } from '../../agent-runtime/contracts/runtime-address';
import { buildTeamManagedAgentId } from './team-managed-agent';
import type { TeamRoleSessionBinding, TeamRunStatus } from './team-run';
import type { TeamRoleAgentMaterializationSpec } from '../ports/team-agent-materialization-port';

export interface TeamManagedAgentRecord {
  readonly teamId: string;
  readonly roleId: string;
  readonly agentId: string;
  readonly displayName: string;
  readonly workspace: string;
  readonly endpoint: RuntimeEndpointRef;
  readonly model?: string;
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
  readonly managedAgents: readonly TeamManagedAgentRecord[];
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

export function buildTeamRoleSessionBindings(input: {
  readonly teamId: string;
  readonly runId: string;
  readonly endpoint: RuntimeEndpointRef;
  readonly roles: readonly TeamRoleAgentMaterializationSpec[];
}): TeamRoleSessionBinding[] {
  return input.roles.map((role) => buildTeamRoleSessionBinding({
    teamId: input.teamId,
    runId: input.runId,
    roleId: role.roleId,
    agentId: buildTeamManagedAgentId(input.teamId, role.roleId),
    endpoint: input.endpoint,
  }));
}

export function buildTeamManagedAgentRecords(input: {
  readonly teamId: string;
  readonly endpoint: RuntimeEndpointRef;
  readonly roles: readonly TeamRoleAgentMaterializationSpec[];
}): TeamManagedAgentRecord[] {
  return input.roles.map((role) => ({
    teamId: input.teamId,
    roleId: role.roleId,
    agentId: buildTeamManagedAgentId(input.teamId, role.roleId),
    displayName: role.agentName,
    workspace: role.workspacePath,
    endpoint: input.endpoint,
    ...(role.model ? { model: role.model } : {}),
  }));
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
  return Array.from(new Set(managedAgents.map((agent) => agent.agentId)));
}
