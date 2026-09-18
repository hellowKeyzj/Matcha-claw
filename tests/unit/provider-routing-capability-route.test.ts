import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { handleCapabilityRoutes } from '../../electron/api/routes/capabilities';

const request = {
  id: 'provider.routing',
  operationId: 'providerRouting.list',
  scope: { kind: 'provider-routing' },
  target: { kind: 'provider-routing' },
  input: { kind: 'list' },
};

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

describe('provider routing capability route', () => {
  it('forwards only provider.routing to the dedicated routing transport', async () => {
    const execute = vi.fn().mockResolvedValue({ status: 200, body: { routing: null } });
    const result = response();

    await expect(handleCapabilityRoutes(
      incoming(request) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/capabilities/execute'),
      { runtimeHostTransports: { providerRoutingTransport: { execute } } } as never,
    )).resolves.toBe(true);

    expect(execute).toHaveBeenCalledWith(request);
    expect(result.state).toEqual({ statusCode: 200, body: { routing: null } });
  });

  it('redacts routing transport failures', async () => {
    const result = response();
    await handleCapabilityRoutes(
      incoming(request) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/capabilities/execute'),
      { runtimeHostTransports: { providerRoutingTransport: { execute: vi.fn().mockRejectedValue(new Error('private loopback failure')) } } } as never,
    );
    expect(result.state).toEqual({
      statusCode: 503,
      body: { success: false, error: 'Provider routing is unavailable' },
    });
  });

  it('rejects malformed provider.routing before dispatch and leaves provider.models unclaimed', async () => {
    const execute = vi.fn();
    const invalid = response();
    await handleCapabilityRoutes(
      incoming({ ...request, operationId: 'providerModels.list' }) as never,
      invalid.raw as never,
      new URL('http://127.0.0.1/api/capabilities/execute'),
      { runtimeHostTransports: { providerRoutingTransport: { execute } } } as never,
    );
    expect(invalid.state).toEqual({
      statusCode: 400,
      body: { success: false, error: 'Provider routing request is invalid' },
    });

    const models = response();
    await handleCapabilityRoutes(
      incoming({ ...request, id: 'provider.models', operationId: 'providerModels.list' }) as never,
      models.raw as never,
      new URL('http://127.0.0.1/api/capabilities/execute'),
      { runtimeHostTransports: { providerRoutingTransport: { execute } } } as never,
    );
    expect(execute).not.toHaveBeenCalled();
    expect(models.state).toEqual({
      statusCode: 404,
      body: { success: false, error: 'Capability is not available' },
    });
  });
});
