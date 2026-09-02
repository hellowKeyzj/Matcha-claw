import { describe, expect, it, vi } from 'vitest';
import { createRuntimeHostDeliveryIssuer } from '../../electron/main/runtime-host-delivery/bootstrap';
import { createSessionContentTransport } from '../../electron/main/runtime-host-delivery/transport/sessions/content';

const identity = {
  endpoint: {
    kind: 'native-runtime' as const,
    runtimeAdapterId: 'openclaw' as const,
    runtimeInstanceId: 'local' as const,
  },
  agentId: 'test',
  sessionKey: 'agent:test:main',
};

function request(options: Partial<{ endpointSessionId: string; offset: number; limit: number }> = {}) {
  return {
    id: 'session.management',
    operationId: 'sessions.content.load',
    scope: { kind: 'session' as const, identity },
    target: { kind: 'session' as const, identity },
    input: {
      sessionKey: identity.sessionKey,
      sessionIdentity: identity,
      endpointSessionId: options.endpointSessionId ?? 'main',
      contentRef: 'content-ref-1',
      offset: options.offset ?? 7,
      limit: options.limit ?? 65536,
    },
  };
}

function successBody() {
  return {
    contentRef: 'content-ref-1',
    offset: 7,
    text: 'chunk',
    nextOffset: 12,
    totalBytes: 12,
    complete: true,
  };
}

function unavailableResponse() {
  return { status: 503 as const, body: { success: false as const, error: 'Session content is unavailable' as const } };
}

function sealedUnavailableResponse(): Response {
  return new Response(JSON.stringify(unavailableResponse().body), { status: 503 });
}

function decodeDecision(authorization: string): Record<string, unknown> {
  const [, , payload] = authorization.replace('Bearer ', '').split('.');
  return JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'));
}

describe('SessionContentTransport', () => {
  it('binds content loads to the fixed endpoint and sealed decision', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(sealedUnavailableResponse());
    const transport = createSessionContentTransport(createRuntimeHostDeliveryIssuer(), 19420, fetcher);

    await expect(transport.load(request())).resolves.toEqual(unavailableResponse());

    expect(fetcher.mock.calls[0]![0]).toBe('http://127.0.0.1:19420/api/sessions/content');
    expect(decodeDecision(fetcher.mock.calls[0]![1].headers.Authorization).endpoint).toBe('/api/sessions/content');
    expect(decodeDecision(fetcher.mock.calls[0]![1].headers.Authorization).capability).toBe('session.management');
  });

  it('rejects identity and sessionKey mismatches before delivery', async () => {
    const fetcher = vi.fn();
    const transport = createSessionContentTransport(createRuntimeHostDeliveryIssuer(), 19420, fetcher);
    const scopeMismatch = {
      ...request(),
      scope: {
        kind: 'session' as const,
        identity: { ...identity, sessionKey: 'agent:test:other' },
      },
    };
    const inputIdentityMismatch = {
      ...request(),
      input: {
        ...request().input,
        sessionIdentity: { ...identity, agentId: 'other' },
      },
    };
    const inputSessionKeyMismatch = {
      ...request(),
      input: { ...request().input, sessionKey: 'agent:test:other' },
    };

    for (const malformed of [scopeMismatch, inputIdentityMismatch, inputSessionKeyMismatch]) {
      await expect(transport.load(malformed)).resolves.toEqual(unavailableResponse());
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('accepts valid content chunks and forwards endpointSessionId', async () => {
    const body = successBody();
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }));
    const transport = createSessionContentTransport(createRuntimeHostDeliveryIssuer(), 19420, fetcher);

    await expect(transport.load(request({ endpointSessionId: 'main' }))).resolves.toEqual({ status: 200, body });

    const sent = JSON.parse(fetcher.mock.calls[0]![1].body as string) as { input: Record<string, unknown> };
    expect(sent.input).toMatchObject({
      endpointSessionId: 'main',
      sessionKey: identity.sessionKey,
      sessionIdentity: identity,
      offset: 7,
      limit: 65536,
    });
  });

  it('rejects malformed requests and private response payloads with sealed unavailable', async () => {
    const fetcher = vi.fn();
    const transport = createSessionContentTransport(createRuntimeHostDeliveryIssuer(), 19420, fetcher);

    await expect(transport.load({
      ...request(),
      input: { ...request().input, private: 'secret' },
    })).resolves.toEqual(unavailableResponse());
    expect(fetcher).not.toHaveBeenCalled();

    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ...successBody(), private: 'secret' }), { status: 200 }));
    await expect(transport.load(request())).resolves.toEqual(unavailableResponse());
  });

  it('rejects mismatched response content identity', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...successBody(), contentRef: 'content-ref-2' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...successBody(), offset: 8 }), { status: 200 }));
    const transport = createSessionContentTransport(createRuntimeHostDeliveryIssuer(), 19420, fetcher);

    await expect(transport.load(request())).resolves.toEqual(unavailableResponse());
    await expect(transport.load(request())).resolves.toEqual(unavailableResponse());
  });
});
