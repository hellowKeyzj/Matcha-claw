import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { handleTeamLifecycleRoutes } from '../../electron/api/routes/team-lifecycle';

function request(body: unknown, method = 'POST') {
  return Object.assign(Readable.from([JSON.stringify(body)]), {
    method,
    headers: { 'content-type': 'application/json' },
  });
}

function response() {
  const state = { statusCode: 200, body: undefined as unknown };
  return {
    state,
    raw: {
      get statusCode() { return state.statusCode; },
      set statusCode(value: number) { state.statusCode = value; },
      setHeader: () => {},
      end: (content?: string) => { state.body = content ? JSON.parse(content) : undefined; },
    },
  };
}

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

describe('Team lifecycle Host API route', () => {
  it('forwards only the fixed lifecycle actions', async () => {
    const list = vi.fn().mockResolvedValue({ status: 200, body: { success: true, action: 'list', runs: [] } });
    const create = vi.fn().mockResolvedValue({ status: 200, body: { success: true, action: 'create', runId: 'run-1', outcome: 'created' } });
    const remove = vi.fn().mockImplementation(async (target) => 'runId' in target
      ? { status: 202, body: { callId: 'a'.repeat(32), accepted: true } }
      : { status: 200, body: { success: true, action: 'delete', teamId: 'team-1', outcome: 'deleted' } });
    const resume = vi.fn().mockResolvedValue({ status: 200, body: { success: true, action: 'resume', runs: [] } });
    const cancel = vi.fn().mockResolvedValue({ status: 200, body: { success: true, action: 'cancel', runId: 'run-1', state: 'cancelling' } });
    const transport = { list, create, delete: remove, resume, cancel };

    for (const [body, expected, requestValue] of [
      [{ action: 'list', teamId: 'team-1' }, list, { teamId: 'team-1' }],
      [{ action: 'create', ...createRequest }, create, createRequest],
      [{ action: 'delete', teamId: 'team-1', idempotencyKey: 'delete-1' }, remove, { teamId: 'team-1', idempotencyKey: 'delete-1' }],
      [{ action: 'resume', teamId: 'team-1', idempotencyKey: 'resume-1' }, resume, { teamId: 'team-1', idempotencyKey: 'resume-1' }],
      [{ action: 'cancel', runId: 'run-1', idempotencyKey: 'cancel-1' }, cancel, { runId: 'run-1', idempotencyKey: 'cancel-1' }],
      [{ action: 'delete', runId: 'run-1', idempotencyKey: 'delete-1' }, remove, { runId: 'run-1', idempotencyKey: 'delete-1' }],
    ] as const) {
      const result = response();
      await expect(handleTeamLifecycleRoutes(
        request(body) as never,
        result.raw as never,
        new URL('http://127.0.0.1/api/team/lifecycle'),
        transport,
      )).resolves.toBe(true);
      expect(expected).toHaveBeenCalledWith(requestValue);
    }
  });

  it('rejects extra, legacy, and malformed fields before transport invocation', async () => {
    const transport = { list: vi.fn(), create: vi.fn(), delete: vi.fn(), resume: vi.fn(), cancel: vi.fn() };
    for (const body of [
      { action: 'create', ...createRequest, packagePath: 'legacy' },
      { action: 'create', teamId: 'team-1', runId: 'run-1', idempotencyKey: 'create-1' },
      { action: 'delete', teamId: 'team-1' },
      { action: 'deleteTeam', teamId: 'team-1', idempotencyKey: 'delete-1' },
      { action: 'cancel', runId: 'run-1', idempotencyKey: 'cancel-1', reason: 'legacy' },
      { action: 'tombstone', runId: 'run-1', idempotencyKey: 'delete-1' },
      { action: 'list', teamId: 'team-1', sessions: [] },
      { action: 'resume', teamId: 'team\n1', idempotencyKey: 'resume-1' },
    ]) {
      const result = response();
      await handleTeamLifecycleRoutes(
        request(body) as never,
        result.raw as never,
        new URL('http://127.0.0.1/api/team/lifecycle'),
        transport,
      );
      expect(result.state).toEqual({
        statusCode: 400,
        body: { success: false, error: 'Team lifecycle request is invalid' },
      });
    }
    expect(transport.list).not.toHaveBeenCalled();
    expect(transport.create).not.toHaveBeenCalled();
    expect(transport.delete).not.toHaveBeenCalled();
    expect(transport.resume).not.toHaveBeenCalled();
    expect(transport.cancel).not.toHaveBeenCalled();
  });

  it('does not claim unrelated routes', async () => {
    await expect(handleTeamLifecycleRoutes(
      request({ action: 'list', teamId: 'team-1' }) as never,
      response().raw as never,
      new URL('http://127.0.0.1/api/team/not-lifecycle'),
      { list: vi.fn(), create: vi.fn(), delete: vi.fn(), resume: vi.fn(), cancel: vi.fn() },
    )).resolves.toBe(false);
  });
});
