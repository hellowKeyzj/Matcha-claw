import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { handleSecurityEmergencyRoutes } from '../../electron/api/routes/security-emergency';

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

describe('security emergency Host API route', () => {
  it('forwards only the fixed empty request to the dedicated transport', async () => {
    const run = vi.fn().mockResolvedValue({ status: 200, body: { outcome: 'outcome_unknown' } });
    const result = response();

    await expect(handleSecurityEmergencyRoutes(
      request({}) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/security/emergency'),
      { run },
    )).resolves.toBe(true);

    expect(run).toHaveBeenCalledOnce();
    expect(result.state).toEqual({ statusCode: 200, body: { outcome: 'outcome_unknown' } });
  });

  it('rejects every non-empty or non-POST request without invoking the transport', async () => {
    const run = vi.fn();
    for (const [body, method] of [[{ target: 'all' }, 'POST'], [{}, 'GET']] as const) {
      const result = response();
      await handleSecurityEmergencyRoutes(
        request(body, method) as never,
        result.raw as never,
        new URL('http://127.0.0.1/api/security/emergency'),
        { run },
      );
      if (method === 'POST') {
        expect(result.state).toEqual({
          statusCode: 400,
          body: { success: false, error: 'Security emergency request is invalid' },
        });
      }
    }
    expect(run).not.toHaveBeenCalled();
  });

  it('does not claim unrelated routes', async () => {
    const result = response();
    await expect(handleSecurityEmergencyRoutes(
      request({}) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/security'),
      { run: vi.fn() },
    )).resolves.toBe(false);
  });
});
