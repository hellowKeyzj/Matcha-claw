import { describe, expect, it, vi } from 'vitest';
import { createTeamLifecycleTransport } from '../../electron/main/runtime-host-delivery/transport/teams/lifecycle';

const unavailable = { success: false, error: 'Team lifecycle is unavailable' };
const workflowPlan = {
  workflowPlanId: 'plan-1',
  runId: 'run-1',
  title: 'Team plan',
  status: 'planned',
  groups: [{
    groupId: 'group-1',
    title: 'Primary work',
    taskIds: ['task-1'],
    join: { requireCompleted: true, allowFailed: false, retryLimit: 0 },
  }],
  tasks: [{
    taskId: 'task-1',
    roleId: 'role-1',
    title: 'Primary task',
    prompt: 'Do the work',
    dependsOnTaskIds: [],
    outputArtifactKind: null,
  }],
  idempotencyKey: 'plan-1',
  createdAt: 1,
};
const createRequest = {
  teamId: 'team-1',
  runId: 'run-1',
  idempotencyKey: 'create-1',
  workflowPlan,
  sourceIdentity: 'teamskill:source',
  templateRevision: 1,
};

describe('Electron Main Team lifecycle transport', () => {
  it('signs each fixed lifecycle action and sends its closed request', async () => {
    const signDecision = vi.fn().mockReturnValue('signed-decision');
    const fetcher = vi.fn()
      .mockResolvedValueOnce({
        status: 200,
        json: async () => ({
          success: true,
          action: 'list',
          runs: [{ state: 'available', teamId: 'team-1', runId: 'run-1', teamRevision: 1, graphStatus: 'running' }],
        }),
      })
      .mockResolvedValueOnce({
        status: 200,
        json: async () => ({ success: true, action: 'create', runId: 'run-1', outcome: 'created' }),
      })
      .mockResolvedValueOnce({
        status: 200,
        json: async () => ({ success: true, action: 'delete', teamId: 'team-1', outcome: 'deleted' }),
      })
      .mockResolvedValueOnce({
        status: 200,
        json: async () => ({ success: true, action: 'resume', runs: [{ runId: 'run-1', state: 'active' }] }),
      })
      .mockResolvedValueOnce({
        status: 200,
        json: async () => ({ success: true, action: 'cancel', runId: 'run-1', state: 'cancelling' }),
      })
      .mockResolvedValueOnce({
        status: 202,
        json: async () => ({ callId: 'a'.repeat(32), accepted: true }),
      });
    const transport = createTeamLifecycleTransport({ verificationKey: 'public', signDecision }, 3233, fetcher);

    await expect(transport.list({ teamId: 'team-1' })).resolves.toMatchObject({ status: 200, body: { action: 'list' } });
    await expect(transport.create(createRequest)).resolves.toMatchObject({ status: 200, body: { action: 'create' } });
    await expect(transport.delete({ teamId: 'team-1', idempotencyKey: 'delete-1' })).resolves.toMatchObject({ status: 200, body: { action: 'delete' } });
    await expect(transport.resume({ teamId: 'team-1', idempotencyKey: 'resume-1' })).resolves.toMatchObject({ status: 200, body: { action: 'resume' } });
    await expect(transport.cancel({ runId: 'run-1', idempotencyKey: 'cancel-1' })).resolves.toMatchObject({ status: 200, body: { action: 'cancel' } });
    await expect(transport.delete({ runId: 'run-1', idempotencyKey: 'delete-1' })).resolves.toMatchObject({ status: 202, body: { callId: 'a'.repeat(32), accepted: true } });

    for (const capability of [
      'team.lifecycle.list',
      'team.lifecycle.create',
      'team.lifecycle.delete',
      'team.lifecycle.resume',
      'team.lifecycle.cancel',
    ]) {
      expect(signDecision).toHaveBeenCalledWith(expect.objectContaining({
        endpoint: '/api/team/lifecycle',
        scope: 'team:write',
        capability,
        subject: 'team-lifecycle',
      }));
    }
    expect(fetcher).toHaveBeenNthCalledWith(1, 'http://127.0.0.1:3233/api/team/lifecycle', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer signed-decision' }),
      body: JSON.stringify({ action: 'list', teamId: 'team-1' }),
    }));
    expect(fetcher).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:3233/api/team/lifecycle', expect.objectContaining({
      body: JSON.stringify({ action: 'create', ...createRequest }),
    }));
    expect(fetcher).toHaveBeenNthCalledWith(3, 'http://127.0.0.1:3233/api/team/lifecycle', expect.objectContaining({
      body: JSON.stringify({ action: 'delete', teamId: 'team-1', idempotencyKey: 'delete-1' }),
    }));
    expect(fetcher).toHaveBeenNthCalledWith(6, 'http://127.0.0.1:3233/api/team/lifecycle', expect.objectContaining({
      body: JSON.stringify({ action: 'delete', runId: 'run-1', idempotencyKey: 'delete-1' }),
    }));
  });

  it('does not sign malformed local requests', async () => {
    const signDecision = vi.fn();
    const fetcher = vi.fn();
    const transport = createTeamLifecycleTransport({ verificationKey: 'public', signDecision }, 3233, fetcher);

    await expect(transport.create({ ...createRequest, idempotencyKey: 'invalid key' })).resolves.toEqual({ status: 503, body: unavailable });
    await expect(transport.create({ ...createRequest, workflowPlan: { ...workflowPlan, createdAt: -1 } })).resolves.toEqual({ status: 503, body: unavailable });
    await expect(transport.delete({ teamId: 'team\n1', idempotencyKey: 'delete-1' })).resolves.toEqual({ status: 503, body: unavailable });
    await expect(transport.cancel({ runId: 'run-1', idempotencyKey: 'invalid key' })).resolves.toEqual({ status: 503, body: unavailable });
    await expect(transport.list({ teamId: 'run\n1' })).resolves.toEqual({ status: 503, body: unavailable });

    expect(signDecision).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('projects only sealed create outcomes and redacts native details', async () => {
    const malformed = createTeamLifecycleTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      3233,
      vi.fn().mockResolvedValue({ status: 200, json: async () => ({ success: true, action: 'create', runId: 'run-1', outcome: 'outcome_unknown', nativeDetail: 'private owner detail' }) }),
    );
    const unknown = createTeamLifecycleTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      3233,
      vi.fn().mockResolvedValue({ status: 409, json: async () => ({ success: false, error: 'Team lifecycle outcome is unknown' }) }),
    );
    const rejected = createTeamLifecycleTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      3233,
      vi.fn().mockResolvedValue({ status: 409, json: async () => ({ success: false, error: 'Team lifecycle request was rejected' }) }),
    );
    const failed = createTeamLifecycleTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      3233,
      vi.fn().mockRejectedValue(new Error('private loopback failure')),
    );

    const malformedResponse = await malformed.create(createRequest);
    expect(malformedResponse).toEqual({ status: 503, body: unavailable });
    expect(JSON.stringify(malformedResponse)).not.toContain('private owner detail');
    await expect(unknown.create(createRequest)).resolves.toEqual({
      status: 409,
      body: { success: false, error: 'Team lifecycle outcome is unknown' },
    });
    await expect(rejected.create(createRequest)).resolves.toEqual({
      status: 409,
      body: { success: false, error: 'Team lifecycle request was rejected' },
    });
    const response = await failed.create(createRequest);
    expect(response).toEqual({ status: 503, body: unavailable });
    expect(JSON.stringify(response)).not.toContain('private loopback failure');
  });
});
