import { describe, expect, it, vi } from 'vitest';
import { createTeamRuntimeJobPort, DELETE_TEAM_MANAGED_AGENTS_JOB } from '../../runtime-host/application/team-runtime/team-runtime-jobs';

const endpoint = {
  kind: 'native-runtime',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
} as const;

describe('team runtime jobs', () => {
  it('submits managed agent deletion to the low-priority RuntimeLongTask queue with team dedupe', async () => {
    const submit = vi.fn(() => ({
      success: true,
      job: {
        id: 'job-1',
        type: DELETE_TEAM_MANAGED_AGENTS_JOB,
        queue: 'low',
        status: 'queued',
        queuedAt: 1000,
        attempts: 0,
        maxAttempts: 3,
      },
    } as const));
    const jobs = createTeamRuntimeJobPort({ submit });
    const managedAgents = [
      { teamId: 'team-package', roleId: 'leader', agentId: 'agent-1', displayName: 'leader', workspace: '/openclaw/teambuddy/team-package/leader', endpoint },
      { teamId: 'team-package', roleId: 'researcher', agentId: 'agent-2', displayName: 'researcher', workspace: '/openclaw/teambuddy/team-package/researcher', endpoint },
    ] as const;

    const result = await jobs.submitDeleteManagedAgents({
      teamId: 'team-package',
      endpoint,
      managedAgents,
    });

    expect(result.job.type).toBe(DELETE_TEAM_MANAGED_AGENTS_JOB);
    expect(submit).toHaveBeenCalledWith(DELETE_TEAM_MANAGED_AGENTS_JOB, {
      teamId: 'team-package',
      endpoint,
      managedAgents,
    }, {
      queue: 'low',
      dedupeKey: `${DELETE_TEAM_MANAGED_AGENTS_JOB}:team-package`,
      maxAttempts: 3,
      retryDelayMs: 1_000,
      resultRetention: 'drop',
    });
  });
});
