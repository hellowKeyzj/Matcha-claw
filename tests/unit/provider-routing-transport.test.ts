import { describe, expect, it, vi } from 'vitest';

import { createRuntimeHostDeliveryIssuer } from '../../electron/main/runtime-host-delivery/issuer';
import { createProviderRoutingTransport } from '../../electron/main/runtime-host-delivery/transport/providers/routing';

const listRequest = {
  id: 'provider.routing' as const,
  operationId: 'providerRouting.list' as const,
  scope: { kind: 'provider-routing' as const },
  target: { kind: 'provider-routing' as const },
  input: { kind: 'list' as const },
};

const replaceRequest = {
  id: 'provider.routing' as const,
  operationId: 'providerRouting.replace' as const,
  scope: { kind: 'provider-routing' as const },
  target: { kind: 'provider-routing' as const },
  input: {
    kind: 'replace' as const,
    routing: {
      revision: 4,
      routes: [{
        capability: 'chat' as const,
        primary: { accountId: 'primary', modelId: 'model-primary' },
        fallbacks: [{ accountId: 'fallback', modelId: 'model-fallback' }],
        timeoutMs: 5_000,
      }],
    },
  },
};

describe('provider routing delivery transport', () => {
  it('binds a routing decision to the fixed shared localhost endpoint', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ routing: null }),
    });
    const transport = createProviderRoutingTransport(createRuntimeHostDeliveryIssuer(), 3227, fetcher);

    await expect(transport.execute(listRequest)).resolves.toEqual({ status: 200, body: { routing: null } });
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:3227/api/provider-routing', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(listRequest),
    }));
    const authorization = fetcher.mock.calls[0]?.[1]?.headers.Authorization as string;
    const decision = authorization.slice('Bearer capability-decision.v1.'.length).split('.')[0];
    expect(JSON.parse(Buffer.from(decision, 'base64url').toString())).toMatchObject({
      endpoint: '/api/provider-routing',
      scope: 'providers:routing',
      capability: 'providerRouting.list',
      subject: 'provider-routing',
    });
  });

  it('strictly decodes the sealed list and replace DTOs', async () => {
    const list = createProviderRoutingTransport(
      createRuntimeHostDeliveryIssuer(),
      3227,
      vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({ routing: { revision: 4, routes: replaceRequest.input.routing.routes } }),
      }),
    );
    await expect(list.execute(listRequest)).resolves.toEqual({
      status: 200,
      body: { routing: { revision: 4, routes: replaceRequest.input.routing.routes } },
    });

    const replace = createProviderRoutingTransport(
      createRuntimeHostDeliveryIssuer(),
      3227,
      vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({
          success: true,
          desired: { status: 'stored', revision: 4 },
          persisted: { status: 'confirmed' },
          native: { changed: false, applied: { status: 'unknown' }, observed: { status: 'unavailable' } },
          commit: 'committed',
        }),
      }),
    );
    await expect(replace.execute(replaceRequest)).resolves.toEqual({
      status: 200,
      body: {
        success: true,
        desired: { status: 'stored', revision: 4 },
        persisted: { status: 'confirmed' },
        native: { changed: false, applied: { status: 'unknown' }, observed: { status: 'unavailable' } },
        commit: 'committed',
      },
    });
  });

  it.each(['credential', 'credentialReference'])('rejects a routing request with a legacy %s reference', async (legacyKey) => {
    const fetcher = vi.fn();
    const transport = createProviderRoutingTransport(createRuntimeHostDeliveryIssuer(), 3227, fetcher);
    const route = replaceRequest.input.routing.routes[0]!;

    await expect(transport.execute({
      ...replaceRequest,
      input: {
        ...replaceRequest.input,
        routing: {
          ...replaceRequest.input.routing,
          routes: [{
            ...route,
            primary: { [legacyKey]: 'credential:v1:primary', modelId: route.primary.modelId },
          }],
        },
      },
    })).resolves.toEqual({
      status: 400,
      body: { success: false, error: 'Provider routing request is invalid' },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects model-provider input and redacts invalid native responses', async () => {
    const fetcher = vi.fn();
    const transport = createProviderRoutingTransport(createRuntimeHostDeliveryIssuer(), 3227, fetcher);
    await expect(transport.execute({
      ...replaceRequest,
      input: { ...replaceRequest.input, provider: 'private-provider' },
    })).resolves.toEqual({
      status: 400,
      body: { success: false, error: 'Provider routing request is invalid' },
    });
    expect(fetcher).not.toHaveBeenCalled();

    const malformed = createProviderRoutingTransport(
      createRuntimeHostDeliveryIssuer(),
      3227,
      vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({ routing: { revision: 4, routes: [{ credential: 'private-reference' }] } }),
      }),
    );
    await expect(malformed.execute(listRequest)).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Provider routing is unavailable' },
    });
  });
});
