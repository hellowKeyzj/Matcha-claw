import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { handleTeamApprovalsRoutes } from '../../electron/api/routes/team-approvals';

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

describe('Team approvals Host API route', () => {
  it('forwards the fixed team and run identifiers to its dedicated transport', async () => {
    const read = vi.fn().mockResolvedValue({
      status: 200,
      body: { teamId: 'team-1', runId: 'run-1', approvals: [] },
    });
    const result = response();

    await expect(handleTeamApprovalsRoutes(
      request({ teamId: 'team-1', runId: 'run-1' }) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/team/approvals'),
      { read },
    )).resolves.toBe(true);

    expect(read).toHaveBeenCalledWith({ teamId: 'team-1', runId: 'run-1' });
    expect(result.state).toEqual({
      statusCode: 200,
      body: { teamId: 'team-1', runId: 'run-1', approvals: [] },
    });
  });

  it('rejects expanded, malformed, and unrelated requests before transport invocation', async () => {
    const read = vi.fn();
    for (const body of [
      { teamId: 'team-1', runId: 'run-1', receipt: 'private' },
      { teamId: 'team-1', runId: '' },
      { teamId: 'team-1', runId: 'run\n1' },
    ]) {
      const result = response();
      await handleTeamApprovalsRoutes(
        request(body) as never,
        result.raw as never,
        new URL('http://127.0.0.1/api/team/approvals'),
        { read },
      );
      expect(result.state).toEqual({
        statusCode: 400,
        body: { success: false, error: 'Team pending approvals request is invalid' },
      });
    }
    expect(read).not.toHaveBeenCalled();
    await expect(handleTeamApprovalsRoutes(
      request({ teamId: 'team-1', runId: 'run-1' }, 'GET') as never,
      response().raw as never,
      new URL('http://127.0.0.1/api/team/approvals'),
      { read },
    )).resolves.toBe(false);
  });
});
