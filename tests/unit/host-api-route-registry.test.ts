import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { createHostApiRequestHandler } from '../../electron/api/server';

function request(body: unknown, method = 'POST') {
  return Object.assign(Readable.from([JSON.stringify(body)]), {
    method,
    headers: { 'content-type': 'application/json' },
  });
}

function emptyRequest(method = 'GET') {
  return Object.assign(Readable.from([]), {
    method,
    headers: {},
  });
}

function response() {
  const state = { statusCode: 200, body: undefined as unknown };
  return {
    state,
    raw: {
      get statusCode() { return state.statusCode; },
      set statusCode(value: number) { state.statusCode = value; },
      setHeader: vi.fn(),
      end: (content?: string) => { state.body = content ? JSON.parse(content) : undefined; },
    },
  };
}

function hostApiContext(overrides: {
  search?: ReturnType<typeof vi.fn>;
  read?: ReturnType<typeof vi.fn>;
  mutate?: ReturnType<typeof vi.fn>;
} = {}) {
  return {
    clawHubSkillInstallTransport: { install: vi.fn() },
    clawHubSkillSearchTransport: { search: overrides.search ?? vi.fn() },
    fleetTransport: {
      read: overrides.read ?? vi.fn(),
      mutate: overrides.mutate ?? vi.fn(),
    },
  } as never;
}

describe('Host API route handler registry', () => {
  it('registers the ClawHub search wrapper through the real request handler', async () => {
    const search = vi.fn().mockResolvedValue({
      status: 200,
      body: {
        success: true,
        results: [{ slug: 'web-search', name: 'Web Search', description: '', version: 'latest' }],
      },
    });
    const result = response();
    const handler = createHostApiRequestHandler(hostApiContext({ search }), 13210);

    await handler(
      Object.assign(request({ query: '' }), { url: '/api/clawhub/search' }) as never,
      result.raw as never,
    );

    expect(search).toHaveBeenCalledWith({ query: '' });
    expect(result.state).toEqual({
      statusCode: 200,
      body: {
        success: true,
        results: [{ slug: 'web-search', name: 'Web Search', description: '', version: 'latest' }],
      },
    });
  });

  it('registers the Fleet metrics wrapper through the real request handler', async () => {
    const read = vi.fn().mockResolvedValue({
      status: 200,
      body: { metrics: {} },
    });
    const result = response();
    const handler = createHostApiRequestHandler(hostApiContext({ read }), 13210);

    await handler(
      Object.assign(emptyRequest(), { url: '/api/remote-fleet/metrics' }) as never,
      result.raw as never,
    );

    expect(read).toHaveBeenCalledWith({
      operation: 'fleet.metrics.get',
      input: { kind: 'metrics' },
    });
    expect(result.state).toEqual({ statusCode: 200, body: { metrics: {} } });
  });

  it('registers the Fleet remove-node wrapper through the real request handler', async () => {
    const mutate = vi.fn().mockResolvedValue({
      status: 200,
      body: { outcome: 'nodeRetired' },
    });
    const result = response();
    const handler = createHostApiRequestHandler(hostApiContext({ mutate }), 13210);

    await handler(
      Object.assign(request({ nodeId: 'node-1' }), { url: '/api/remote-fleet/remove-node' }) as never,
      result.raw as never,
    );

    expect(mutate).toHaveBeenCalledWith({
      operation: 'fleet.nodes.retire',
      input: { kind: 'nodeRetire', payload: { id: 'node-1' } },
    });
    expect(result.state).toEqual({ statusCode: 200, body: { outcome: 'nodeRetired' } });
  });

  it('keeps deploy-environment sealed as unavailable without transport dispatch', async () => {
    const read = vi.fn();
    const mutate = vi.fn();
    const result = response();
    const handler = createHostApiRequestHandler(hostApiContext({ read, mutate }), 13210);

    await handler(
      Object.assign(request({ environmentId: 'environment-1' }), {
        url: '/api/remote-fleet/deploy-environment',
      }) as never,
      result.raw as never,
    );

    expect(result.state).toEqual({
      statusCode: 503,
      body: { success: false, error: 'Fleet data is unavailable' },
    });
    expect(read).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });
});
