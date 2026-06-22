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

    const result = await jobs.submitDeleteManagedAgents({
      teamId: 'team-package',
      endpoint,
      agentIds: ['agent-1', 'agent-2'],
      workspacePaths: ['/openclaw/teambuddy/team-package'],
    });

    expect(result.job.type).toBe(DELETE_TEAM_MANAGED_AGENTS_JOB);
    expect(submit).toHaveBeenCalledWith(DELETE_TEAM_MANAGED_AGENTS_JOB, {
      teamId: 'team-package',
      endpoint,
      agentIds: ['agent-1', 'agent-2'],
      workspacePaths: ['/openclaw/teambuddy/team-package'],
    }, {
      queue: 'low',
      dedupeKey: `${DELETE_TEAM_MANAGED_AGENTS_JOB}:team-package`,
      maxAttempts: 3,
      retryDelayMs: 1_000,
      resultRetention: 'drop',
    });
  });
});
