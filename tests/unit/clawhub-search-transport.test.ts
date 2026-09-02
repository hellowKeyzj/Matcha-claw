import { describe, expect, it, vi } from 'vitest';

import { createRuntimeHostDeliveryIssuer } from '../../electron/main/runtime-host-delivery/bootstrap';
import { createClawHubSkillSearchTransport } from '../../electron/main/runtime-host-delivery/transport/skills/clawhub-search';

const searchRequest = { query: '  web search  ' } as const;

function transport(fetcher: typeof fetch) {
  return createClawHubSkillSearchTransport(createRuntimeHostDeliveryIssuer(), 3227, fetcher);
}

describe('ClawHub search delivery transport', () => {
  it('binds the fixed marketplace DTO to the signed localhost endpoint', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({
        success: true,
        results: [{
          slug: 'web-search',
          name: 'Web Search',
          description: 'Search the web',
          version: '1.2.3',
          author: 'ClawHub',
          downloads: 99,
          stars: 7,
        }],
      }),
    });

    await expect(transport(fetcher).search(searchRequest)).resolves.toEqual({
      status: 200,
      body: {
        success: true,
        results: [{
          slug: 'web-search',
          name: 'Web Search',
          description: 'Search the web',
          version: '1.2.3',
          author: 'ClawHub',
          downloads: 99,
          stars: 7,
        }],
      },
    });
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:3227/api/clawhub/search', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(searchRequest),
    }));
    const authorization = fetcher.mock.calls[0]?.[1]?.headers?.Authorization as string;
    const decision = authorization.slice('Bearer capability-decision.v1.'.length).split('.')[0];
    expect(JSON.parse(Buffer.from(decision, 'base64url').toString())).toMatchObject({
      endpoint: '/api/clawhub/search',
      scope: 'skills:search',
      capability: 'clawhubSkill.search',
      subject: 'clawhub-skill-search',
    });
  });

  it('passes the renderer empty-query discovery request without adding native fields', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ success: true, results: [] }),
    });
    const request = { query: '' };

    await expect(transport(fetcher).search(request)).resolves.toEqual({
      status: 200,
      body: { success: true, results: [] },
    });
    expect(fetcher.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(request));
  });

  it('rejects malformed public input before loopback delivery', async () => {
    const fetcher = vi.fn();
    const search = transport(fetcher);

    await expect(search.search({ query: 'web', limit: 50 })).resolves.toEqual({
      status: 400,
      body: { success: false, error: 'ClawHub search request is invalid' },
    });
    await expect(search.search({ query: 'x'.repeat(257) })).resolves.toEqual({
      status: 400,
      body: { success: false, error: 'ClawHub search request is invalid' },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('preserves child invalid-request responses', async () => {
    const response = await transport(
      vi.fn().mockResolvedValue({
        status: 400,
        json: async () => ({ success: false, error: 'ClawHub search request is invalid' }),
      }),
    ).search(searchRequest);

    expect(response).toEqual({
      status: 400,
      body: { success: false, error: 'ClawHub search request is invalid' },
    });
  });

  it.each([
    {
      success: true,
      results: [{ slug: 'web-search', name: 'Web Search', description: '', version: 'latest', score: 0.9 }],
    },
    {
      success: true,
      results: [{ slug: 'web-search', name: 'Web Search', description: '', version: 'latest', updatedAt: 42 }],
    },
    { success: true, results: [{ slug: 'web-search', name: 'Web Search', description: '', version: 'latest', privateField: 'secret' }] },
    { success: false, error: 'private native gateway path' },
  ])('fails closed for non-sealed native results', async (body) => {
    const response = await transport(
      vi.fn().mockResolvedValue({ status: 200, json: async () => body }),
    ).search(searchRequest);

    expect(response).toEqual({
      status: 503,
      body: { success: false, error: 'ClawHub search is unavailable' },
    });
    expect(JSON.stringify(response)).not.toContain('private');
  });

  it('redacts loopback failures', async () => {
    const response = await transport(
      vi.fn().mockRejectedValue(new Error('private native failure at C:/secret')),
    ).search(searchRequest);

    expect(response).toEqual({
      status: 503,
      body: { success: false, error: 'ClawHub search is unavailable' },
    });
    expect(JSON.stringify(response)).not.toContain('C:/secret');
  });
});
