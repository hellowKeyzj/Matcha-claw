import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { handleTeamRoleSessionsRoutes } from '../../electron/api/routes/team-role-sessions';

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

describe('Team role-session Host API route', () => {
  it('forwards only the fixed team request', async () => {
    const list = vi.fn().mockResolvedValue({ status: 200, body: { success: true, sessions: [] } });
    const result = response();

    await expect(handleTeamRoleSessionsRoutes(
      request({ teamId: 'team-1' }) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/team/role-sessions'),
      { list },
    )).resolves.toBe(true);

    expect(list).toHaveBeenCalledWith({ teamId: 'team-1' });
    expect(result.state).toEqual({ statusCode: 200, body: { success: true, sessions: [] } });
  });

  it('rejects rich, malformed, and unrelated requests before transport invocation', async () => {
    const list = vi.fn();
    for (const body of [
      { teamId: 'team-1', runId: 'run-1' },
      { teamId: 'team\n1' },
      { sessions: [] },
    ]) {
      const result = response();
      await handleTeamRoleSessionsRoutes(
        request(body) as never,
        result.raw as never,
        new URL('http://127.0.0.1/api/team/role-sessions'),
        { list },
      );
      expect(result.state).toEqual({
        statusCode: 400,
        body: { success: false, error: 'Team role sessions request is invalid' },
      });
    }
    expect(list).not.toHaveBeenCalled();
    await expect(handleTeamRoleSessionsRoutes(
      request({ teamId: 'team-1' }) as never,
      response().raw as never,
      new URL('http://127.0.0.1/api/team/not-role-sessions'),
      { list },
    )).resolves.toBe(false);
  });
});
