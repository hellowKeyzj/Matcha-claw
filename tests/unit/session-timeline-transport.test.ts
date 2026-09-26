import { describe, expect, it, vi } from 'vitest';
import { createRuntimeHostDeliveryIssuer } from '../../electron/main/runtime-host-delivery/issuer';
import { createSessionTimelineTransport } from '../../electron/main/runtime-host-delivery/transport/sessions/timeline';
import {
  assistantItem,
  completeFact,
  incompleteFact,
  sessionView,
  windowView,
} from './helpers/session-fixtures';

const identity = {
  endpoint: {
    kind: 'native-runtime' as const,
    runtimeAdapterId: 'openclaw' as const,
    runtimeInstanceId: 'local' as const,
  },
  agentId: 'test',
  sessionKey: 'agent:test:main',
};

const ordinaryOwnership = { kind: 'ordinary' } as const;
const teamOwnership = {
  kind: 'team',
  teamId: 'team-1',
  teamRunId: 'team-run-1',
  roleId: 'role-1',
  sessionRef: identity.sessionKey,
} as const;

function request(
  operationId: 'sessions.load' | 'sessions.window',
  options: { endpointSessionId?: string } = {},
) {
  return {
    id: 'session.management',
    operationId,
    scope: { kind: 'session' as const, identity },
    target: { kind: 'session' as const, identity },
    input: {
      sessionKey: identity.sessionKey,
      sessionIdentity: identity,
      ...(options.endpointSessionId === undefined ? {} : { endpointSessionId: options.endpointSessionId }),
      ...(operationId === 'sessions.window' ? { mode: 'latest' as const } : {}),
    },
  };
}

function unavailableResponse() {
  return { status: 503 as const, body: { success: false as const, error: 'Session timeline is unavailable' as const } };
}

function sealedUnavailableResponse(): Response {
  return new Response(JSON.stringify(unavailableResponse().body), { status: 503 });
}

function decodeDecision(authorization: string): Record<string, unknown> {
  const [, , payload] = authorization.replace('Bearer ', '').split('.');
  return JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'));
}

function canonicalView(options: Parameters<typeof sessionView>[1] = {}) {
  return sessionView(identity.sessionKey, { identity, ...options });
}

function omitOwnership<T extends { ownership: unknown }>(value: T): Omit<T, 'ownership'> {
  const { ownership: _ownership, ...withoutOwnership } = value;
  void _ownership;
  return withoutOwnership;
}

const runtimeHostTransportPort = 32_111;

describe('SessionTimelineTransport', () => {
  it('binds each operation to its fixed endpoint and sealed decision', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(sealedUnavailableResponse())
      .mockResolvedValueOnce(sealedUnavailableResponse());
    const transport = createSessionTimelineTransport(createRuntimeHostDeliveryIssuer(), runtimeHostTransportPort, fetcher);

    await expect(transport.load(request('sessions.load'))).resolves.toEqual(unavailableResponse());
    await expect(transport.window(request('sessions.window'))).resolves.toEqual(unavailableResponse());

    expect(fetcher.mock.calls[0]![0]).toBe('http://127.0.0.1:32111/api/sessions/load');
    expect(fetcher.mock.calls[1]![0]).toBe('http://127.0.0.1:32111/api/sessions/window');
    expect(decodeDecision(fetcher.mock.calls[0]![1].headers.Authorization).endpoint).toBe('/api/sessions/load');
    expect(decodeDecision(fetcher.mock.calls[0]![1].headers.Authorization).capability).toBe('session.management');
    expect(decodeDecision(fetcher.mock.calls[1]![1].headers.Authorization).endpoint).toBe('/api/sessions/window');
    expect(decodeDecision(fetcher.mock.calls[1]![1].headers.Authorization).capability).toBe('session.management');
  });

  it('rejects identity and sessionKey mismatches before delivery', async () => {
    const fetcher = vi.fn();
    const transport = createSessionTimelineTransport(createRuntimeHostDeliveryIssuer(), runtimeHostTransportPort, fetcher);
    const scopeMismatch = {
      ...request('sessions.load'),
      scope: {
        kind: 'session' as const,
        identity: { ...identity, sessionKey: 'agent:test:other' },
      },
    };
    const inputIdentityMismatch = {
      ...request('sessions.load'),
      input: {
        ...request('sessions.load').input,
        sessionIdentity: { ...identity, agentId: 'agent:other' },
      },
    };
    const inputSessionKeyMismatch = {
      ...request('sessions.load'),
      input: { ...request('sessions.load').input, sessionKey: 'agent:test:other' },
    };

    for (const malformed of [scopeMismatch, inputIdentityMismatch, inputSessionKeyMismatch]) {
      await expect(transport.load(malformed)).resolves.toEqual(unavailableResponse());
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('accepts a complete canonical SessionView without legacy projections', async () => {
    const view = canonicalView({
      epoch: 2,
      seq: 4,
      cursor: 4,
      items: completeFact([assistantItem('item-1', 'done', { runId: 'run-1' })]),
      window: completeFact(windowView(1)),
    });
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(view), { status: 200 }));
    const transport = createSessionTimelineTransport(createRuntimeHostDeliveryIssuer(), runtimeHostTransportPort, fetcher);

    await expect(transport.load(request('sessions.load'))).resolves.toEqual({ status: 200, body: view });
  });

  it.each([
    ['null', null],
    ['ordinary', ordinaryOwnership],
    ['team', teamOwnership],
  ] as const)('accepts a complete canonical SessionView with %s ownership', async (_name, ownership) => {
    const view = canonicalView({ ownership });
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(view), { status: 200 }));
    const transport = createSessionTimelineTransport(createRuntimeHostDeliveryIssuer(), runtimeHostTransportPort, fetcher);

    await expect(transport.load(request('sessions.load'))).resolves.toEqual({ status: 200, body: view });
  });

  it('rejects response identity and sessionKey mismatches', async () => {
    const identityMismatch = canonicalView({
      identity: { ...identity, sessionKey: 'agent:test:other' },
    });
    const sessionKeyMismatch = sessionView('agent:test:other', {
      identity: { ...identity, sessionKey: 'agent:test:other' },
    });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(identityMismatch), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(sessionKeyMismatch), { status: 200 }));
    const transport = createSessionTimelineTransport(createRuntimeHostDeliveryIssuer(), runtimeHostTransportPort, fetcher);

    await expect(transport.load(request('sessions.load'))).resolves.toEqual(unavailableResponse());
    await expect(transport.load(request('sessions.load'))).resolves.toEqual(unavailableResponse());
  });

  it.each([
    ['unknown facts', { ...canonicalView(), items: 'unknown', completeness: 'unknown' }],
    ['incomplete facts', canonicalView({
      items: incompleteFact([assistantItem('item-1', 'partial')], ['bounded_history']),
      tools: 'unavailable',
      completeness: { incomplete: { missing: ['bounded_history', 'catalog'] } },
    })],
  ])('accepts canonical SessionView with %s', async (_name, view) => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(view), { status: 200 }));
    const transport = createSessionTimelineTransport(createRuntimeHostDeliveryIssuer(), runtimeHostTransportPort, fetcher);

    await expect(transport.load(request('sessions.load'))).resolves.toEqual({ status: 200, body: view });
  });

  it('rejects malformed requests and private response payloads with sealed unavailable', async () => {
    const fetcher = vi.fn();
    const transport = createSessionTimelineTransport(createRuntimeHostDeliveryIssuer(), runtimeHostTransportPort, fetcher);

    await expect(transport.window({
      ...request('sessions.window'),
      input: { ...request('sessions.window').input, private: 'secret' },
    })).resolves.toEqual(unavailableResponse());
    expect(fetcher).not.toHaveBeenCalled();

    const privateView = { ...canonicalView(), private: 'secret' };
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify(privateView), { status: 200 }));
    await expect(transport.load(request('sessions.load'))).resolves.toEqual(unavailableResponse());

    fetcher.mockResolvedValueOnce(new Response(JSON.stringify(omitOwnership(canonicalView())), { status: 200 }));
    await expect(transport.load(request('sessions.load'))).resolves.toEqual(unavailableResponse());

    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({
      ...canonicalView(),
      ownership: { ...teamOwnership, roleId: '' },
    }), { status: 200 }));
    await expect(transport.load(request('sessions.load'))).resolves.toEqual(unavailableResponse());
  });

  it('binds endpointSessionId to the canonical load and window requests', async () => {
    const view = canonicalView({ items: completeFact([assistantItem('item-1', 'done')]), window: completeFact(windowView(1)) });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(view), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(view), { status: 200 }));
    const transport = createSessionTimelineTransport(createRuntimeHostDeliveryIssuer(), runtimeHostTransportPort, fetcher);

    await expect(transport.load(request('sessions.load', { endpointSessionId: 'main' })))
      .resolves.toEqual({ status: 200, body: view });
    await expect(transport.window(request('sessions.window', { endpointSessionId: 'main' })))
      .resolves.toEqual({ status: 200, body: view });

    for (const [, init] of fetcher.mock.calls) {
      const sent = JSON.parse(init.body as string) as { input: Record<string, unknown> };
      expect(sent.input).toMatchObject({
        endpointSessionId: 'main',
        sessionKey: identity.sessionKey,
        sessionIdentity: identity,
      });
    }
  });

  it('rejects invalid canonical window metadata', async () => {
    const view = canonicalView({
      window: completeFact({ ...windowView(1), windowEndOffset: 2 }),
    });
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(view), { status: 200 }));
    const transport = createSessionTimelineTransport(createRuntimeHostDeliveryIssuer(), runtimeHostTransportPort, fetcher);

    await expect(transport.load(request('sessions.load'))).resolves.toEqual(unavailableResponse());
  });
});
