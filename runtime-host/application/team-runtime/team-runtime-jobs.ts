import type { RuntimeEndpointRef } from '../agent-runtime/contracts/runtime-address';
import type { RuntimeLongTaskSubmission, RuntimeLongTaskSubmissionPort } from '../runtime-host/runtime-task-ports';
import type { TeamManagedAgentRecord } from './domain/team-instance';

export const DELETE_TEAM_MANAGED_AGENTS_JOB = 'teamRuntime.deleteManagedAgents';

export type TeamRuntimeJobSubmission = RuntimeLongTaskSubmission;

export interface DeleteTeamManagedAgentsJobPayload {
  readonly teamId: string;
  readonly endpoint: RuntimeEndpointRef;
  readonly managedAgents: readonly TeamManagedAgentRecord[];
}

export interface TeamRuntimeJobPort {
  submitDeleteManagedAgents(payload: DeleteTeamManagedAgentsJobPayload): Promise<TeamRuntimeJobSubmission>;
}

export function createTeamRuntimeJobPort(tasks: RuntimeLongTaskSubmissionPort): TeamRuntimeJobPort {
  return {
    submitDeleteManagedAgents: async (payload) => tasks.submit(DELETE_TEAM_MANAGED_AGENTS_JOB, payload, {
      queue: 'low',
      dedupeKey: `${DELETE_TEAM_MANAGED_AGENTS_JOB}:${payload.teamId}`,
      maxAttempts: 3,
      retryDelayMs: 1_000,
      resultRetention: 'drop',
    }),
  };
}
