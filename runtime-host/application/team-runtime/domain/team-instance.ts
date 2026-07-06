import type { RuntimeEndpointRef } from '../../agent-runtime/contracts/runtime-address';
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

export function collectTeamManagedAgentIds(managedAgents: readonly TeamManagedAgentRecord[]): string[] {
  return Array.from(new Set(managedAgents.filter((agent) => agent.lifecycle !== 'external').map((agent) => agent.agentId)));
}
