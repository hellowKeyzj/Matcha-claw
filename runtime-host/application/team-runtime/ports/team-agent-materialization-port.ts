import type { RuntimeEndpointRef } from '../../agent-runtime/contracts/runtime-address';
import type { TeamManagedAgentRecord } from '../domain/team-instance';

export interface TeamAgentFileSpec {
  readonly path: string;
  readonly content: string;
}

export interface TeamRoleAgentMaterializationSpec {
  readonly roleId: string;
  readonly agentName: string;
  readonly purpose?: string;
  readonly workspacePath: string;
  readonly agentDir?: string;
  readonly files: readonly TeamAgentFileSpec[];
  readonly skills?: readonly string[];
  readonly tools?: readonly string[];
  readonly model?: string;
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
  readonly agentIds: readonly string[];
  readonly workspacePaths?: readonly string[];
}

export interface TeamAgentMaterializationPort {
  materialize(input: TeamAgentMaterializationSpec): Promise<TeamAgentMaterializationResult>;
  removeTeamAgents(input: RemoveTeamAgentsInput): Promise<void>;
}
