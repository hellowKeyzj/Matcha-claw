import { describe, expect, it, vi } from 'vitest';
import {
  REMOTE_FLEET_RUNTIME_AGENT_DEFAULT_TIMEOUT_MS,
  createRemoteFleetHttpRuntimeAgentTransport,
  createRemoteFleetRuntimeAgentTransportDispatcher,
  type RemoteFleetRuntimeAgentTargetResolverPort,
} from '../../runtime-host/application/remote-fleet/remote-fleet-runtime-agent-transport-dispatcher';
import type { RuntimeAgentTransport } from '../../runtime-host/application/remote-fleet/remote-fleet-agent-client';
import type { RemoteFleetCommandDispatchEnvelope } from '../../runtime-host/application/remote-fleet/remote-fleet-command-dispatch';

function dispatchEnvelope(overrides: Partial<RemoteFleetCommandDispatchEnvelope> = {}): RemoteFleetCommandDispatchEnvelope {
  return {
    envelopeVersion: 'remote-fleet-command-dispatch/v1',
    commandId: 'cmd-1',
    idempotencyKey: 'idem-1',
    agentId: 'agent-1',
    nodeId: 'node-1',
    commandName: 'probe-node',
    dispatchTarget: {
      endpointUrl: 'https://runtime-agent.example.test/rpc',
      credentialRef: { kind: 'secret-ref', ref: 'remote-fleet://node-1/runtime-agent-token' },
      timeoutMs: 5000,
    },
    request: {
      commandId: 'cmd-1',
      kind: 'probe-node',
      node: {
        id: 'node-1',
        displayName: 'Node 1',
        targetKind: 'container',
        labels: [],
        enabled: true,
        publicConfig: {},
        secretRefs: {},
        health: { reason: 'unknown' },
        createdAt: '2026-07-06T10:00:00.000Z',
        updatedAt: '2026-07-06T10:00:00.000Z',
      },
      publicConfig: {},
      payload: {
        payloadType: 'runtime-agent-probe-node',
        nodeId: 'node-1',
        agentId: 'agent-1',
        target: { targetKind: 'container', labels: [] },
      },
    },
    ...overrides,
  };
}

function targetResolver(): RemoteFleetRuntimeAgentTargetResolverPort {
  return {
    resolveTarget: vi.fn<RemoteFleetRuntimeAgentTargetResolverPort['resolveTarget']>(async () => ({
      resultType: 'resolved',
      target: {
        endpointUrl: 'https://runtime-agent.example.test/rpc',
        credential: { kind: 'bearer-token', token: 'plain-runtime-agent-token', credentialId: 'credential-1' },
        timeoutMs: 5000,
      },
    })),
  };
}

describe('Remote Fleet RuntimeAgent transport dispatcher', () => {
  it('sends a command accept request through the resolved RuntimeAgent transport', async () => {
    const envelope = dispatchEnvelope();
    const transport = {
      request: vi.fn<RuntimeAgentTransport['request']>(async (input) => ({
        resultType: 'delivered',
        response: {
          type: 'runtime-agent.command.accept.response',
          requestId: input.request.requestId,
          agentId: envelope.agentId,
          commandId: envelope.commandId,
          resultType: 'accepted',
          acceptedAt: '2026-07-06T10:00:01.000Z',
        },
      })),
    } satisfies RuntimeAgentTransport;
    const resolver = targetResolver();
    const dispatcher = createRemoteFleetRuntimeAgentTransportDispatcher({
      transport,
      targetResolver: resolver,
      clock: { nowIso: () => '2026-07-06T10:00:00.000Z' },
      createRequestId: () => 'accept-request-1',
    });

    await expect(dispatcher.dispatchCommand(envelope)).resolves.toEqual({ resultType: 'accepted', accepted: true });
    expect(resolver.resolveTarget).toHaveBeenCalledWith(envelope);
    expect(transport.request).toHaveBeenCalledWith({
      target: {
        endpointUrl: 'https://runtime-agent.example.test/rpc',
        credential: { kind: 'bearer-token', token: 'plain-runtime-agent-token', credentialId: 'credential-1' },
        timeoutMs: 5000,
      },
      request: {
        type: 'runtime-agent.command.accept',
        requestId: 'accept-request-1',
        agentId: 'agent-1',
        sentAt: '2026-07-06T10:00:00.000Z',
        commandId: 'cmd-1',
        commandName: 'probe-node',
        issuedAt: '2026-07-06T10:00:00.000Z',
        idempotencyKey: 'idem-1',
        payload: envelope.request,
      },
    });
  });

  it('returns unavailable without calling transport when target resolution is unavailable', async () => {
    const transport = {
      request: vi.fn<RuntimeAgentTransport['request']>(),
    } satisfies RuntimeAgentTransport;
    const dispatcher = createRemoteFleetRuntimeAgentTransportDispatcher({
      transport,
      targetResolver: {
        resolveTarget: async () => ({ resultType: 'unavailable', reason: 'target-not-found' }),
      },
    });

    await expect(dispatcher.dispatchCommand(dispatchEnvelope())).resolves.toEqual({ resultType: 'unavailable', accepted: false });
    expect(transport.request).not.toHaveBeenCalled();
  });

  it('returns unavailable without calling transport when the resolved target is not a valid RuntimeAgent target', async () => {
    const transport = {
      request: vi.fn<RuntimeAgentTransport['request']>(),
    } satisfies RuntimeAgentTransport;
    const dispatcher = createRemoteFleetRuntimeAgentTransportDispatcher({
      transport,
      targetResolver: {
        resolveTarget: async () => ({
          resultType: 'resolved',
          target: {
            endpointUrl: 'file:///tmp/runtime-agent.sock',
            credential: { kind: 'bearer-token', token: 'plain-runtime-agent-token' },
          },
        }),
      },
    });

    await expect(dispatcher.dispatchCommand(dispatchEnvelope())).resolves.toEqual({ resultType: 'unavailable', accepted: false });
    expect(transport.request).not.toHaveBeenCalled();
  });

  it('returns unavailable when the RuntimeAgent transport fails delivery', async () => {
    const transport = {
      request: vi.fn<RuntimeAgentTransport['request']>(async () => ({
        resultType: 'failed',
        reason: 'timeout',
        message: 'RuntimeAgent acceptCommand timed out.',
      })),
    } satisfies RuntimeAgentTransport;
    const dispatcher = createRemoteFleetRuntimeAgentTransportDispatcher({
      transport,
      targetResolver: targetResolver(),
      createRequestId: () => 'accept-request-1',
    });

    await expect(dispatcher.dispatchCommand(dispatchEnvelope())).resolves.toEqual({ resultType: 'unavailable', accepted: false });
  });

  it('returns unavailable when the delivered response does not match the dispatched command', async () => {
    const transport = {
      request: vi.fn<RuntimeAgentTransport['request']>(async () => ({
        resultType: 'delivered',
        response: {
          type: 'runtime-agent.command.accept.response',
          requestId: 'accept-request-1',
          agentId: 'agent-1',
          commandId: 'other-command',
          resultType: 'accepted',
          acceptedAt: '2026-07-06T10:00:01.000Z',
        },
      })),
    } satisfies RuntimeAgentTransport;
    const dispatcher = createRemoteFleetRuntimeAgentTransportDispatcher({
      transport,
      targetResolver: targetResolver(),
      createRequestId: () => 'accept-request-1',
    });

    await expect(dispatcher.dispatchCommand(dispatchEnvelope())).resolves.toEqual({ resultType: 'unavailable', accepted: false });
  });

  it('resolves envelope dispatch targets through the injected secret resolver before HTTP transport delivery', async () => {
    const envelope = dispatchEnvelope();
    const transport = {
      request: vi.fn<RuntimeAgentTransport['request']>(async (input) => ({
        resultType: 'delivered',
        response: {
          type: 'runtime-agent.command.accept.response',
          requestId: input.request.requestId,
          agentId: envelope.agentId,
          commandId: envelope.commandId,
          resultType: 'accepted',
          acceptedAt: '2026-07-06T10:00:01.000Z',
        },
      })),
    } satisfies RuntimeAgentTransport;
    const resolveSecret = vi.fn(async () => ({
      resultType: 'resolved' as const,
      secretRef: 'remote-fleet://node-1/runtime-agent-token',
      plaintextSecretValue: 'plain-runtime-agent-token',
    }));
    const dispatcher = createRemoteFleetRuntimeAgentTransportDispatcher({
      transport,
      secretResolver: { resolveSecret },
      clock: { nowIso: () => '2026-07-06T10:00:00.000Z' },
      createRequestId: () => 'accept-request-1',
    });

    await expect(dispatcher.dispatchCommand(envelope)).resolves.toEqual({ resultType: 'accepted', accepted: true });
    expect(resolveSecret).toHaveBeenCalledWith({
      secretRef: 'remote-fleet://node-1/runtime-agent-token',
      purpose: 'worker-command-execution',
      commandExecutionId: 'cmd-1',
    });
    expect(transport.request).toHaveBeenCalledWith(expect.objectContaining({
      target: {
        endpointUrl: 'https://runtime-agent.example.test/rpc',
        credential: {
          kind: 'bearer-token',
          token: 'plain-runtime-agent-token',
          credentialId: 'remote-fleet://node-1/runtime-agent-token',
        },
        timeoutMs: 5000,
      },
    }));
  });

  it('uses a finite default deadline for RuntimeAgent HTTP requests without an explicit timeout', async () => {
    const httpClient = {
      request: vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          type: 'runtime-agent.command.accept.response',
          requestId: 'accept-request-default-timeout',
          agentId: 'agent-1',
          commandId: 'cmd-1',
          resultType: 'accepted',
          acceptedAt: '2026-07-06T10:00:01.000Z',
        }),
        text: async () => '',
      })),
    };
    const transport = createRemoteFleetHttpRuntimeAgentTransport({ httpClient });

    await transport.request({
      target: {
        endpointUrl: 'https://runtime-agent.example.test/rpc',
        credential: { kind: 'bearer-token', token: 'plain-runtime-agent-token' },
      },
      request: {
        type: 'runtime-agent.command.accept',
        requestId: 'accept-request-default-timeout',
        agentId: 'agent-1',
        sentAt: '2026-07-06T10:00:00.000Z',
        commandId: 'cmd-1',
        commandName: 'probe-node',
        issuedAt: '2026-07-06T10:00:00.000Z',
      },
    });

    const requestInit = httpClient.request.mock.calls[0]?.[1];
    expect(requestInit?.signal).toBeInstanceOf(AbortSignal);
    expect((requestInit?.signal as AbortSignal).aborted).toBe(false);
    expect(REMOTE_FLEET_RUNTIME_AGENT_DEFAULT_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('delivers RuntimeAgent requests through the concrete HTTP transport', async () => {
    const httpClient = {
      request: vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          type: 'runtime-agent.command.accept.response',
          requestId: 'accept-request-1',
          agentId: 'agent-1',
          commandId: 'cmd-1',
          resultType: 'accepted',
          acceptedAt: '2026-07-06T10:00:01.000Z',
        }),
        text: async () => '',
      })),
    };
    const transport = createRemoteFleetHttpRuntimeAgentTransport({ httpClient });

    await expect(transport.request({
      target: {
        endpointUrl: 'https://runtime-agent.example.test/rpc',
        credential: { kind: 'bearer-token', token: 'plain-runtime-agent-token' },
        timeoutMs: 5000,
      },
      request: {
        type: 'runtime-agent.command.accept',
        requestId: 'accept-request-1',
        agentId: 'agent-1',
        sentAt: '2026-07-06T10:00:00.000Z',
        commandId: 'cmd-1',
        commandName: 'probe-node',
        issuedAt: '2026-07-06T10:00:00.000Z',
      },
    })).resolves.toMatchObject({
      resultType: 'delivered',
      response: { resultType: 'accepted', commandId: 'cmd-1' },
    });
    expect(httpClient.request).toHaveBeenCalledWith('https://runtime-agent.example.test/rpc', expect.objectContaining({
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer plain-runtime-agent-token',
      },
      body: expect.stringContaining('runtime-agent.command.accept'),
      signal: expect.any(AbortSignal),
    }));
  });
});
