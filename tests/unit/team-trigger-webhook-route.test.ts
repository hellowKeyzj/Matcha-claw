import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { handleTeamTriggerRoutes } from '../../electron/api/routes/team-trigger';

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

describe('Team trigger Host API route', () => {
  it('forwards sealed list and fire actions to the fixed transport', async () => {
    const list = vi.fn().mockResolvedValue({
      status: 200,
      body: { success: true, triggers: [] },
    });
    const fire = vi.fn().mockResolvedValue({
      status: 200,
      body: { success: true, runId: 'run-1' },
    });
    const transport = { list, fire };

    for (const [body, expected] of [
      [{ action: 'list', teamId: 'team-1' }, list],
      [{ action: 'fire', runId: 'run-1', startNodeId: 'start-1', source: 'webhook', idempotencyKey: 'fire-1' }, fire],
    ] as const) {
      const result = response();
      await expect(handleTeamTriggerRoutes(
        request(body) as never,
        result.raw as never,
        new URL('http://127.0.0.1/api/team/trigger'),
        transport,
      )).resolves.toBe(true);
      expect(expected).toHaveBeenCalledWith(body);
    }
  });

  it('rejects legacy payload fields and invalid requests before transport invocation', async () => {
    const transport = { list: vi.fn(), fire: vi.fn() };
    for (const body of [
      { action: 'webhook', path: '/deploy/ready', payload: { secret: 'never-forwarded' } },
      { action: 'fire', runId: 'run-1', startNodeId: 'start-1', source: 'webhook', idempotencyKey: 'fire-1', headers: {} },
      { action: 'webhook', path: '/../deploy' },
    ]) {
      const result = response();
      await handleTeamTriggerRoutes(
        request(body) as never,
        result.raw as never,
        new URL('http://127.0.0.1/api/team/trigger'),
        transport,
      );
      expect(result.state).toEqual({
        statusCode: 400,
        body: { success: false, error: 'Team trigger request is invalid' },
      });
    }
    expect(transport.list).not.toHaveBeenCalled();
    expect(transport.fire).not.toHaveBeenCalled();
  });

  it('does not claim unrelated routes', async () => {
    await expect(handleTeamTriggerRoutes(
      request({ action: 'list', teamId: 'team-1' }) as never,
      response().raw as never,
      new URL('http://127.0.0.1/api/team/not-trigger'),
      { list: vi.fn(), fire: vi.fn(), webhook: vi.fn() },
    )).resolves.toBe(false);
  });
});
