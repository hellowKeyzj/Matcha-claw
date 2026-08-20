import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { handleManualTeamRoutes } from '../../electron/api/routes/manual-team';

function request(body: unknown) {
  return Object.assign(Readable.from([JSON.stringify(body)]), {
    method: 'POST',
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

const body = {
  teamId: 'team:manual',
  teamName: 'Manual Team',
  idempotencyKey: 'manual:one',
  roles: [{
    roleId: 'leader', agentId: 'agent:lead', displayName: 'Lead', leader: true,
  }],
};

describe('Manual Team Host API route', () => {
  it('forwards only the closed Manual Team DTO', async () => {
    const materializeAndCreate = vi.fn().mockResolvedValue({ status: 200, body: { status: 'materialized' } });
    const result = response();
    await expect(handleManualTeamRoutes(
      request(body) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/team/manual-materialize-and-create'),
      { materializeAndCreate },
    )).resolves.toBe(true);
    expect(materializeAndCreate).toHaveBeenCalledWith(body);
    expect(result.state).toEqual({ statusCode: 200, body: { status: 'materialized' } });
  });

  it('rejects legacy workspaceBinding and private or expanded fields before transport invocation', async () => {
    const materializeAndCreate = vi.fn();
    for (const invalid of [
      { ...body, workspacePath: 'C:/private' },
      { ...body, roles: [{ ...body.roles[0], workspaceBinding: 'binding.lead' }] },
      { ...body, roles: [{ ...body.roles[0], receipt: 'private' }] },
      { ...body, runId: 'hidden-run' },
    ]) {
      const result = response();
      await handleManualTeamRoutes(
        request(invalid) as never,
        result.raw as never,
        new URL('http://127.0.0.1/api/team/manual-materialize-and-create'),
        { materializeAndCreate },
      );
      expect(result.state).toEqual({
        statusCode: 400,
        body: { success: false, error: 'Manual Team materialization request is invalid' },
      });
    }
    expect(materializeAndCreate).not.toHaveBeenCalled();
  });
});
