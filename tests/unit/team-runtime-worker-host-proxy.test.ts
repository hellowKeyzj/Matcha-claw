import { describe, expect, it } from 'vitest';
import { TeamRuntimeWorkerHostRpc, WorkerProxyTeamRuntimeJobPort, WorkerProxyTeamSkillCatalogPort } from '../../runtime-host/application/team-runtime/team-runtime-worker-host-proxy';
import { DELETE_TEAM_MANAGED_AGENTS_JOB } from '../../runtime-host/application/team-runtime/team-runtime-jobs';
import type { TeamRuntimeHostRequest } from '../../runtime-host/application/team-runtime/team-runtime-worker-contracts';

const endpoint = {
  kind: 'native-runtime',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
} as const;

const deleteManagedAgentsPayload = {
  teamId: 'team-package',
  endpoint,
  agentIds: ['agent-1', 'agent-2'],
  workspacePaths: ['/openclaw/teambuddy/team-package'],
} as const;

describe('TeamRuntime worker host proxy', () => {
  it('resolves host RPC requests by request id', async () => {
    const messages: TeamRuntimeHostRequest[] = [];
    const rpc = new TeamRuntimeWorkerHostRpc((message) => messages.push(message));

    const result = rpc.request('host.job.deleteManagedAgents', deleteManagedAgentsPayload);

    expect(messages).toEqual([{ type: 'host.job.deleteManagedAgents', requestId: 'team-worker-host-1', input: deleteManagedAgentsPayload }]);
    rpc.resolve({ type: 'host.result', requestId: 'team-worker-host-1', ok: true, result: { success: true } });
    await expect(result).resolves.toEqual({ success: true });
  });

  it('rejects host RPC requests with the host error message', async () => {
    const messages: TeamRuntimeHostRequest[] = [];
    const rpc = new TeamRuntimeWorkerHostRpc((message) => messages.push(message));

    const result = rpc.request('host.job.deleteManagedAgents', deleteManagedAgentsPayload);

    rpc.resolve({ type: 'host.result', requestId: messages[0]!.requestId, ok: false, error: { message: 'host queue unavailable' } });
    await expect(result).rejects.toThrow('host queue unavailable');
  });

  it('requests the host skill catalog snapshot', async () => {
    const messages: TeamRuntimeHostRequest[] = [];
    const rpc = new TeamRuntimeWorkerHostRpc((message) => messages.push(message));
    const skillCatalog = new WorkerProxyTeamSkillCatalogPort(rpc);
    const hostSnapshot = { skills: [{ skillKey: 'scenario-planning', installed: true }] };

    const result = skillCatalog.snapshot();

    expect(messages).toEqual([{ type: 'host.skillCatalog.snapshot', requestId: 'team-worker-host-1', input: {} }]);
    rpc.resolve({ type: 'host.result', requestId: 'team-worker-host-1', ok: true, result: hostSnapshot });
    await expect(result).resolves.toBe(hostSnapshot);
  });

  it('returns the real host job submission for managed agent deletion', async () => {
    const messages: TeamRuntimeHostRequest[] = [];
    const rpc = new TeamRuntimeWorkerHostRpc((message) => messages.push(message));
    const jobs = new WorkerProxyTeamRuntimeJobPort(rpc);
    const hostSubmission = {
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
    } as const;

    const result = jobs.submitDeleteManagedAgents(deleteManagedAgentsPayload);

    expect(messages).toEqual([{ type: 'host.job.deleteManagedAgents', requestId: 'team-worker-host-1', input: deleteManagedAgentsPayload }]);
    rpc.resolve({ type: 'host.result', requestId: 'team-worker-host-1', ok: true, result: hostSubmission });
    await expect(result).resolves.toBe(hostSubmission);
  });
});
