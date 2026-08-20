import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { handleSecurityPolicyRoutes } from '../../electron/api/routes/security-policy';

function request(body: unknown, method = 'POST') {
  return Object.assign(Readable.from(method === 'GET' ? [] : [JSON.stringify(body)]), {
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

const policy = {
  preset: 'balanced',
  securityPolicyVersion: 1,
  runtime: { requireApproval: true },
};

describe('Security policy Host API route', () => {
  it('reads the durable policy through the dedicated transport', async () => {
    const read = vi.fn().mockResolvedValue(policy);
    const result = response();

    await expect(handleSecurityPolicyRoutes(
      request(undefined, 'GET') as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/security/policy/current'),
      { read, readAudit: vi.fn(), submit: vi.fn() },
    )).resolves.toBe(true);

    expect(read).toHaveBeenCalledOnce();
    expect(result.state).toEqual({ statusCode: 200, body: policy });
  });

  it('does not fall back to the legacy policy owner when delivery is unavailable', async () => {
    const result = response();

    await handleSecurityPolicyRoutes(
      request(undefined, 'GET') as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/security/policy/current'),
      { read: vi.fn().mockResolvedValue(null), submit: vi.fn() },
    );

    expect(result.state).toEqual({
      statusCode: 503,
      body: { success: false, error: 'Security policy is unavailable' },
    });
  });
});
