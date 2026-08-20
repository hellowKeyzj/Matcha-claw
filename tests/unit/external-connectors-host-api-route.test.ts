import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { handleExternalConnectorsRoutes } from '../../electron/api/routes/external-connectors';

function request(body: unknown, method = 'POST') {
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
      setHeader: vi.fn(),
      end: (content?: string) => { state.body = content ? JSON.parse(content) : undefined; },
    },
  };
}

const transportResponse = { status: 200, body: { connectors: [] } };

describe('external connectors Host API route', () => {
  it('maps the current list/catalog/status Renderer reads to typed operations', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce(transportResponse)
      .mockResolvedValueOnce({ status: 200, body: { programs: [] } })
      .mockResolvedValueOnce({ status: 200, body: { statuses: [] } });

    for (const [path, operationId, kind] of [
      ['/api/external-connectors', 'externalConnectors.list', 'list'],
      ['/api/external-connectors/mcp-server-programs', 'externalConnectors.catalog', 'catalog'],
      ['/api/external-connectors/status', 'externalConnectors.status', 'status'],
    ] as const) {
      const result = response();
      await expect(handleExternalConnectorsRoutes(
        request({}, 'GET') as never,
        result.raw as never,
        new URL(`http://127.0.0.1${path}`),
        { execute },
      )).resolves.toBe(true);
      expect(result.state.statusCode).toBe(200);
      expect(execute).toHaveBeenLastCalledWith({
        id: 'external.connectors',
        operationId,
        scope: { kind: 'external-connector-catalog' },
        target: { kind: 'external-connectors' },
        input: { kind },
      });
    }
  });

  it('maps current probe/upsert/remove mutations to typed operations', async () => {
    const execute = vi.fn().mockResolvedValue({ status: 200, body: { success: true } });
    for (const [path, body, operationId, input] of [
      ['/api/external-connectors/get', { connectorId: 'remote' }, 'externalConnectors.get', { kind: 'get', connectorId: 'remote' }],
      ['/api/external-connectors/probe', { connectorId: 'remote' }, 'externalConnectors.probe', { kind: 'probe', connectorId: 'remote' }],
      ['/api/external-connectors/upsert', { connector: { id: 'remote', kind: 'mcp-http', url: 'https://example.test/mcp' } }, 'externalConnectors.upsert', { kind: 'upsert', connector: { id: 'remote', kind: 'mcp-http', url: 'https://example.test/mcp' } }],
      ['/api/external-connectors/remove', { connectorId: 'remote' }, 'externalConnectors.remove', { kind: 'remove', connectorId: 'remote' }],
    ] as const) {
      const result = response();
      await expect(handleExternalConnectorsRoutes(
        request(body),
        result.raw as never,
        new URL(`http://127.0.0.1${path}`),
        { execute },
      )).resolves.toBe(true);
      expect(execute).toHaveBeenLastCalledWith({
        id: 'external.connectors',
        operationId,
        scope: { kind: 'external-connector-catalog' },
        target: { kind: 'external-connectors' },
        input,
      });
    }
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
  ] as const)('dispatches session status for $endpoint.kind identity', async (sessionIdentity) => {
    const execute = vi.fn().mockResolvedValue({ status: 200, body: { statuses: [] } });
    const result = response();
    await expect(handleExternalConnectorsRoutes(
      request({ sessionIdentity }),
      result.raw as never,
      new URL('http://127.0.0.1/api/external-connectors/session-status'),
      { execute },
    )).resolves.toBe(true);
    expect(result.state).toEqual({ statusCode: 200, body: { statuses: [] } });
    expect(execute).toHaveBeenCalledWith({
      id: 'external.connectors',
      operationId: 'externalConnectors.sessionStatus',
      scope: { kind: 'external-connector-catalog' },
      target: { kind: 'external-connectors' },
      input: { kind: 'sessionStatus', sessionIdentity },
    });
  });

  it('rejects invalid session identities without dispatching', async () => {
    const execute = vi.fn();
    const result = response();
    await expect(handleExternalConnectorsRoutes(
      request({ sessionIdentity: { kind: 'session' } }),
      result.raw as never,
      new URL('http://127.0.0.1/api/external-connectors/session-status'),
      { execute },
    )).resolves.toBe(true);
    expect(result.state).toEqual({
      statusCode: 400,
      body: { success: false, error: 'External connector request is invalid' },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    '/api/external-connectors/get',
    '/api/external-connectors/probe',
  ])('rejects malformed connector ID bodies for %s without dispatching', async (path) => {
    const execute = vi.fn();
    const result = response();
    await handleExternalConnectorsRoutes(
      request({ connectorId: '' }),
      result.raw as never,
      new URL(`http://127.0.0.1${path}`),
      { execute },
    );
    expect(result.state).toEqual({
      statusCode: 400,
      body: { success: false, error: 'External connector request is invalid' },
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
