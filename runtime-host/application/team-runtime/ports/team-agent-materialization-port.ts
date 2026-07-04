import type { RuntimeEndpointRef } from '../../agent-runtime/contracts/runtime-address';
import type { TeamManagedAgentRecord } from '../domain/team-instance';

export type TeamAgentMaterializationSourceType = 'teamskill' | 'manual';

export interface TeamRoleAgentMaterializationSpec {
  readonly roleId: string;
  readonly agentName: string;
  readonly purpose?: string;
  readonly roleMarkdown?: string;
  readonly skills?: readonly string[];
  readonly tools?: readonly string[];
  readonly model?: string;
  readonly sourceAgentId?: string;
  readonly sourceWorkspace?: string;
}

export interface TeamSkillMaterializationSpec {
  readonly name: string;
  readonly skillMarkdown: string;
  readonly workflowMarkdown: string;
  readonly dependenciesYaml: string;
  readonly dependencies: {
    readonly skills: readonly unknown[];
    readonly tools: readonly unknown[];
  };
  readonly bindMarkdown?: string;
}

export interface TeamAgentMaterializationSpec {
  readonly teamId: string;
  readonly endpoint: RuntimeEndpointRef;
  readonly sourceType: TeamAgentMaterializationSourceType;
  readonly teamSkill: TeamSkillMaterializationSpec;
  readonly leader: TeamRoleAgentMaterializationSpec;
  readonly roles: readonly TeamRoleAgentMaterializationSpec[];
}

export interface TeamAgentMaterializationResult {
  readonly teamId: string;
  readonly managedAgents: readonly TeamManagedAgentRecord[];
}

export interface RemoveTeamAgentsInput {
  readonly teamId: string;
  readonly endpoint: RuntimeEndpointRef;
  readonly managedAgents: readonly TeamManagedAgentRecord[];
}

export interface TeamAgentMaterializationPort {
  materialize(input: TeamAgentMaterializationSpec): Promise<TeamAgentMaterializationResult>;
  removeTeamAgents(input: RemoveTeamAgentsInput): Promise<void>;
}
