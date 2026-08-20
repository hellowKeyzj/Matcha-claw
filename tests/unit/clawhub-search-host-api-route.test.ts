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

describe('ClawHub search host API route', () => {
  it('forwards the sealed marketplace response', async () => {
    const search = vi.fn().mockResolvedValue({
      status: 200,
      body: {
        success: true,
        results: [{ slug: 'web-search', name: 'Web Search', description: '', version: 'latest' }],
      },
    });
    const result = response();
    const request = { query: '' };

    await expect(handleClawHubSkillRoutes(
      incoming(request) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/clawhub/search'),
      { install: vi.fn() },
      { search },
    )).resolves.toBe(true);

    expect(search).toHaveBeenCalledWith(request);
    expect(result.state).toEqual({
      statusCode: 200,
      body: {
        success: true,
        results: [{ slug: 'web-search', name: 'Web Search', description: '', version: 'latest' }],
      },
    });
  });

  it('rejects malformed JSON before invoking delivery', async () => {
    const search = vi.fn();
    const result = response();
    const malformed = Object.assign(Readable.from(['{"query":']), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });

    await handleClawHubSkillRoutes(
      malformed as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/clawhub/search'),
      { install: vi.fn() },
      { search },
    );

    expect(search).not.toHaveBeenCalled();
    expect(result.state).toEqual({
      statusCode: 400,
      body: { success: false, error: 'ClawHub search request is invalid' },
    });
  });

  it('redacts route-local transport failures', async () => {
    const result = response();

    await handleClawHubSkillRoutes(
      incoming({ query: 'web' }) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/clawhub/search'),
      { install: vi.fn() },
      { search: vi.fn().mockRejectedValue(new Error('private loopback failure')) },
    );

    expect(result.state).toEqual({
      statusCode: 503,
      body: { success: false, error: 'ClawHub search is unavailable' },
    });
    expect(JSON.stringify(result.state)).not.toContain('private');
  });

  it('does not claim a different method or endpoint', async () => {
    const search = vi.fn();
    const result = response();

    await expect(handleClawHubSkillRoutes(
      incoming({ query: 'web' }, 'GET') as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/clawhub/search'),
      { install: vi.fn() },
      { search },
    )).resolves.toBe(false);
    await expect(handleClawHubSkillRoutes(
      incoming({ query: 'web' }) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/clawhub/other'),
      { install: vi.fn() },
      { search },
    )).resolves.toBe(false);

    expect(search).not.toHaveBeenCalled();
  });
});
