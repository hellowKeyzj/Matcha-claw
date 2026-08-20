import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { handleTeamPublicRoutes } from '../../electron/api/routes/team-public';

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

describe('Team public Host API route', () => {
  it('forwards only the fixed team and run identifiers', async () => {
    const read = vi.fn().mockResolvedValue({
      status: 404,
      body: { success: false, error: 'Team public projection is unavailable' },
    });
    const result = response();

    await expect(handleTeamPublicRoutes(
      request({ teamId: 'team:one', runId: 'run:one' }) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/team/public'),
      { read },
    )).resolves.toBe(true);

    expect(read).toHaveBeenCalledWith({ teamId: 'team:one', runId: 'run:one' });
    expect(result.state).toEqual({
      statusCode: 404,
      body: { success: false, error: 'Team public projection is unavailable' },
    });
  });

  it('rejects extra, malformed, and non-POST requests without invoking the transport', async () => {
    const read = vi.fn();
    for (const [body, method] of [
      [{ teamId: 'team:one', runId: 'run:one', diagnostics: true }, 'POST'],
      [{ teamId: 'team:one', runId: 'run\none' }, 'POST'],
      [{ teamId: 'team:one', runId: '' }, 'POST'],
      [{ teamId: 'team:one', runId: 'run:one' }, 'GET'],
    ] as const) {
      const result = response();
      await handleTeamPublicRoutes(
        request(body, method) as never,
        result.raw as never,
        new URL('http://127.0.0.1/api/team/public'),
        { read },
      );
      if (method === 'POST') {
        expect(result.state).toEqual({
          statusCode: 400,
          body: { success: false, error: 'Team public projection request is invalid' },
        });
      }
    }
    expect(read).not.toHaveBeenCalled();
  });

  it('does not claim unrelated routes', async () => {
    await expect(handleTeamPublicRoutes(
      request({ teamId: 'team:one', runId: 'run:one' }) as never,
      response().raw as never,
      new URL('http://127.0.0.1/api/team'),
      { read: vi.fn() },
    )).resolves.toBe(false);
  });
});
