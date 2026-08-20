import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { handleTeamDecisionRoutes } from '../../electron/api/routes/team-decision';

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

const decision = {
  runId: 'run-1',
  approvalId: 'approval-1',
  decision: 'approve',
  note: 'Approved',
  idempotencyKey: 'decision-1',
};

describe('Team human decision Host API route', () => {
  it('forwards the sealed DTO to the dedicated transport', async () => {
    const resolve = vi.fn().mockResolvedValue({
      status: 200,
      body: { success: true, outcome: 'recorded' },
    });
    const result = response();

    await expect(handleTeamDecisionRoutes(
      request(decision) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/team/decision'),
      { resolve },
    )).resolves.toBe(true);

    expect(resolve).toHaveBeenCalledWith(decision);
    expect(result.state).toEqual({
      statusCode: 200,
      body: { success: true, outcome: 'recorded' },
    });
  });

  it('rejects extra fields, unbounded notes, and non-POST requests without invoking transport', async () => {
    const resolve = vi.fn();
    for (const [body, method] of [
      [{ ...decision, stageId: 'stage-1' }, 'POST'],
      [{ ...decision, note: 'x'.repeat(257) }, 'POST'],
      [decision, 'GET'],
    ] as const) {
      const result = response();
      await handleTeamDecisionRoutes(
        request(body, method) as never,
        result.raw as never,
        new URL('http://127.0.0.1/api/team/decision'),
        { resolve },
      );
      if (method === 'POST') {
        expect(result.state).toEqual({
          statusCode: 400,
          body: { success: false, error: 'Team human decision request is invalid' },
        });
      }
    }
    expect(resolve).not.toHaveBeenCalled();
  });

  it('does not claim unrelated routes', async () => {
    await expect(handleTeamDecisionRoutes(
      request(decision) as never,
      response().raw as never,
      new URL('http://127.0.0.1/api/team'),
      { resolve: vi.fn() },
    )).resolves.toBe(false);
  });
});
