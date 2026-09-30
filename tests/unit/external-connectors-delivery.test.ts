import { describe, expect, it, vi } from 'vitest';
import { createExternalConnectorsTransport } from '../../electron/main/runtime-host-delivery/transport/connectors/external';

describe('external connector sealed delivery', () => {
  const request = {
    id: 'external.connectors',
    operationId: 'externalConnectors.list',
    scope: { kind: 'external-connector-catalog' },
    target: { kind: 'external-connectors' },
    input: { kind: 'list' },
  } as const;

  it('signs only the external connector capability tuple', async () => {
    const signDecision = vi.fn(() => 'decision');
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ connectors: [] }), { status: 200 }));
    const transport = createExternalConnectorsTransport({ signDecision } as never, 43123, fetcher as never);

    await expect(transport.execute(request)).resolves.toEqual({ status: 200, body: { connectors: [] } });
    expect(signDecision).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: '/api/external-connectors',
      scope: 'environment:external-connectors',
      capability: 'externalConnectors.list',
      subject: 'external-connectors',
    }));
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:43123/api/external-connectors', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer decision' }),
    }));
  });

  it('round-trips opaque secret metadata without exposing execution values', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      connectors: [{
        id: 'remote',
        kind: 'mcp-http',
        url: 'https://example.test/mcp',
        secretHeaders: { Authorization: { kind: 'secret-ref', ref: 'credential:v1:opaque' } },
      }],
    }), { status: 200 }));
    const transport = createExternalConnectorsTransport({ signDecision: () => 'decision' } as never, 43123, fetcher as never);

    await expect(transport.execute(request)).resolves.toEqual({
      status: 200,
      body: {
        connectors: [{
          id: 'remote',
          kind: 'mcp-http',
          url: 'https://example.test/mcp',
          secretHeaders: { Authorization: { kind: 'secret-ref', ref: 'credential:v1:opaque' } },
        }],
      },
    });
  });

  it('preserves catalog connection metadata from the Rust DTO', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      programs: [{
        id: 'bundled-plugin:github',
        source: 'bundled-plugin',
        displayName: 'GitHub',
        connectorKinds: ['mcp-http'],
        transport: 'streamable-http',
        command: 'node',
        args: ['server.js'],
        url: 'https://github.example.test/mcp',
        rootPath: '/private/runtime-data/plugins/github',
        envKeys: ['DEBUG'],
        headerKeys: ['X-Connector'],
      }],
    }), { status: 200 }));
    const transport = createExternalConnectorsTransport({ signDecision: () => 'decision' } as never, 43123, fetcher as never);

    await expect(transport.execute({
      ...request,
      operationId: 'externalConnectors.catalog',
      input: { kind: 'catalog' },
    })).resolves.toEqual({
      status: 200,
      body: {
        programs: [{
          id: 'bundled-plugin:github',
          source: 'bundled-plugin',
          displayName: 'GitHub',
          connectorKinds: ['mcp-http'],
          transport: 'streamable-http',
          command: 'node',
          args: ['server.js'],
          url: 'https://github.example.test/mcp',
          rootPath: '/private/runtime-data/plugins/github',
          envKeys: ['DEBUG'],
          headerKeys: ['X-Connector'],
        }],
      },
    });
  });

  it('preserves public connector execution metadata from the Rust DTO', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      connectors: [{
        id: 'local',
        kind: 'mcp-stdio',
        command: 'npx',
        args: ['-y', 'public-server'],
        cwd: '/runtime/connectors/local',
        env: { MCP_MODE: 'public' },
        headers: { 'X-Connector': 'public' },
        config: { profile: 'default' },
      }],
    }), { status: 200 }));
    const transport = createExternalConnectorsTransport({ signDecision: () => 'decision' } as never, 43123, fetcher as never);

    await expect(transport.execute(request)).resolves.toEqual({
      status: 200,
      body: {
        connectors: [{
          id: 'local',
          kind: 'mcp-stdio',
          command: 'npx',
          args: ['-y', 'public-server'],
          cwd: '/runtime/connectors/local',
          env: { MCP_MODE: 'public' },
          headers: { 'X-Connector': 'public' },
          config: { profile: 'default' },
        }],
      },
    });
  });

  it('preserves unknown observed state instead of collapsing it to unavailable', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      callId: 'a'.repeat(32), kind: 'probe',
      status: {
        connectorId: 'remote',
        resultType: 'unknown',
        safeProbe: false,
      },
    }), { status: 200 }));
    const transport = createExternalConnectorsTransport({ signDecision: () => 'decision' } as never, 43123, fetcher as never);

    await expect(transport.execute({
      ...request,
      operationId: 'externalConnectors.observationResult',
      input: { kind: 'observationResult', callId: 'a'.repeat(32) },
    })).resolves.toEqual({
      status: 200,
      body: {
        callId: 'a'.repeat(32), kind: 'probe',
        status: {
          connectorId: 'remote',
          resultType: 'unknown',
          safeProbe: false,
        },
      },
    });
  });

  it('preserves authorization failures with a public redacted body', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      error: 'private authorization details',
    }), { status: 401 }));
    const transport = createExternalConnectorsTransport({ signDecision: () => 'decision' } as never, 43123, fetcher as never);

    await expect(transport.execute(request)).resolves.toEqual({
      status: 401,
      body: { success: false, error: 'External connector authorization failed' },
    });
  });

  it('accepts only explicit desired, applied, and not-observed mutation receipt planes', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      connector: { id: 'remote', kind: 'mcp-http', url: 'https://example.test/mcp' },
      resultType: 'created',
      desired: { status: 'stored' },
      applied: { status: 'unknown' },
      observed: { status: 'not-observed' },
    }), { status: 200 }));
    const transport = createExternalConnectorsTransport({ signDecision: () => 'decision' } as never, 43123, fetcher as never);

    await expect(transport.execute({
      ...request,
      operationId: 'externalConnectors.upsert',
      input: { kind: 'upsert', connector: { id: 'remote', kind: 'mcp-http', url: 'https://example.test/mcp' } },
    })).resolves.toMatchObject({ status: 200 });
  });

  it('preserves the Rust desired revision in a public mutation receipt', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      connector: { id: 'remote', kind: 'mcp-http', url: 'https://example.test/mcp' },
      resultType: 'created',
      desired: { status: 'stored', revision: 1 },
      applied: { status: 'unknown' },
      observed: { status: 'not-observed' },
    }), { status: 200 }));
    const transport = createExternalConnectorsTransport({ signDecision: () => 'decision' } as never, 43123, fetcher as never);

    await expect(transport.execute({
      ...request,
      operationId: 'externalConnectors.upsert',
      input: { kind: 'upsert', connector: { id: 'remote', kind: 'mcp-http', url: 'https://example.test/mcp' } },
    })).resolves.toEqual({
      status: 200,
      body: {
        success: true,
        connector: { id: 'remote', kind: 'mcp-http', url: 'https://example.test/mcp' },
        resultType: 'created',
        desired: { status: 'stored', revision: 1 },
        applied: { status: 'unknown' },
        observed: { status: 'not-observed' },
      },
    });
  });

  it('forwards a valid probe request to the Rust endpoint', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      callId: 'a'.repeat(32), accepted: true,
    }), { status: 202 }));
    const transport = createExternalConnectorsTransport({ signDecision: () => 'decision' } as never, 43123, fetcher as never);

    await expect(transport.execute({
      ...request,
      operationId: 'externalConnectors.probe',
      input: { kind: 'probe', connectorId: 'remote' },
    })).resolves.toEqual({
      status: 202,
      body: { callId: 'a'.repeat(32), accepted: true },
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([
    {
      endpoint: {
        kind: 'native-runtime',
        runtimeAdapterId: 'openclaw',
        runtimeInstanceId: 'local',
      },
      agentId: 'agent-1',
      sessionKey: 'session-1',
    },
    {
      endpoint: {
        kind: 'protocol-connector',
        protocolId: 'openclaw',
        connectorId: 'remote',
        endpointId: 'gateway-1',
      },
      agentId: 'agent-2',
      sessionKey: 'session-2',
    },
  ] as const)('forwards a valid $endpoint.kind session identity', async (sessionIdentity) => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      statuses: [{
        connectorId: 'remote',
        displayName: 'Remote',
        adapterId: 'openclaw',
        targetKind: 'session',
        resultType: 'connected',
        reason: 'ready',
        details: { serverId: 'server-1', sessionKey: 'session-1', toolCount: 2, launchSummary: 'attached' },
        nativePayload: { secret: 'must-not-pass' },
      }],
      nativeSecret: 'must-not-pass',
    }), { status: 200 }));
    const transport = createExternalConnectorsTransport({ signDecision: () => 'decision' } as never, 43123, fetcher as never);

    await expect(transport.execute({
      ...request,
      operationId: 'externalConnectors.sessionStatus',
      input: { kind: 'sessionStatus', sessionIdentity },
    })).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'External connectors are unavailable' },
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('accepts and safely projects a valid session status response', async () => {
    const sessionIdentity = {
      endpoint: { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' },
      agentId: 'agent-1',
      sessionKey: 'session-1',
    } as const;
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      callId: 'a'.repeat(32), kind: 'sessionStatus', sessionIdentity,
      statuses: [{
        connectorId: 'remote',
        displayName: 'Remote',
        adapterId: 'openclaw',
        targetKind: 'session',
        resultType: 'pending',
        reason: 'starting',
        details: { serverId: 'server-1', toolCount: 2, launchSummary: 'attached' },
      }],
    }), { status: 200 }));
    const transport = createExternalConnectorsTransport({ signDecision: () => 'decision' } as never, 43123, fetcher as never);

    await expect(transport.execute({
      ...request,
      operationId: 'externalConnectors.observationResult',
      input: { kind: 'observationResult', callId: 'a'.repeat(32), sessionIdentity },
    })).resolves.toEqual({
      status: 200,
      body: {
        callId: 'a'.repeat(32), kind: 'sessionStatus', sessionIdentity,
        statuses: [{
          connectorId: 'remote',
          displayName: 'Remote',
          adapterId: 'openclaw',
          targetKind: 'session',
          resultType: 'pending',
          reason: 'starting',
          details: { serverId: 'server-1', toolCount: 2, launchSummary: 'attached' },
        }],
      },
    });
  });

  it('rejects an invalid session identity without dispatching', async () => {
    const fetcher = vi.fn();
    const transport = createExternalConnectorsTransport({ signDecision: () => 'decision' } as never, 43123, fetcher as never);

    await expect(transport.execute({
      ...request,
      operationId: 'externalConnectors.sessionStatus',
      input: {
        kind: 'sessionStatus',
        sessionIdentity: {
          endpoint: { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' },
          agentId: '',
          sessionKey: 'session-1',
        },
      },
    })).resolves.toEqual({
      status: 400,
      body: { success: false, error: 'External connector request is invalid' },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['secretEnv', 'secretHeaders', 'secretConfigRefs'])('rejects a request containing invalid %s metadata', async (field) => {
    const fetcher = vi.fn();
    const transport = createExternalConnectorsTransport({ signDecision: () => 'decision' } as never, 43123, fetcher as never);

    await expect(transport.execute({
      ...request,
      operationId: 'externalConnectors.upsert',
      input: {
        kind: 'upsert',
        connector: {
          id: 'remote',
          kind: 'mcp-http',
          url: 'https://example.test/mcp',
          [field]: { Authorization: 'resolved-secret-value' },
        },
      },
    })).resolves.toEqual({
      status: 400,
      body: { success: false, error: 'External connector request is invalid' },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
