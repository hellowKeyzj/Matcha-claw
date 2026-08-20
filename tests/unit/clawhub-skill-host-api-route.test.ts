import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { handleClawHubSkillRoutes } from '../../electron/api/routes/clawhub-skill';

function incoming(body: unknown, method = 'POST') {
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

describe('ClawHub skill install host API route', () => {
  it('forwards the sealed public DTO and result unchanged', async () => {
    const install = vi.fn().mockResolvedValue({
      status: 200,
      body: { outcome: 'accepted', slug: 'skill-alpha', version: '1.2.3' },
    });
    const result = response();
    const request = { slug: 'skill-alpha', version: '1.2.3', force: false };

    await expect(handleClawHubSkillRoutes(
      incoming(request) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/clawhub/skills/install'),
      { install },
      { search: vi.fn() },
    )).resolves.toBe(true);

    expect(install).toHaveBeenCalledWith(request);
    expect(result.state).toEqual({
      statusCode: 200,
      body: { outcome: 'accepted', slug: 'skill-alpha', version: '1.2.3' },
    });
  });

  it('rejects malformed JSON before invoking delivery', async () => {
    const install = vi.fn();
    const result = response();
    const malformed = Object.assign(Readable.from(['{"slug":']), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });

    await handleClawHubSkillRoutes(
      malformed as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/clawhub/skills/install'),
      { install },
      { search: vi.fn() },
    );

    expect(install).not.toHaveBeenCalled();
    expect(result.state).toEqual({
      statusCode: 400,
      body: { outcome: 'rejected', slug: 'invalid' },
    });
  });

  it('redacts route-local transport failures', async () => {
    const result = response();

    await handleClawHubSkillRoutes(
      incoming({ slug: 'skill-alpha', force: false }) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/clawhub/skills/install'),
      { install: vi.fn().mockRejectedValue(new Error('private loopback failure')) },
      { search: vi.fn() },
    );

    expect(result.state).toEqual({
      statusCode: 503,
      body: { outcome: 'unknown', slug: 'invalid' },
    });
    expect(JSON.stringify(result.state)).not.toContain('private');
  });

  it('does not claim a different method or endpoint', async () => {
    const install = vi.fn();
    const result = response();

    await expect(handleClawHubSkillRoutes(
      incoming({ slug: 'skill-alpha', force: false }, 'GET') as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/clawhub/skills/install'),
      { install },
      { search: vi.fn() },
    )).resolves.toBe(false);

    expect(install).not.toHaveBeenCalled();
  });
});
