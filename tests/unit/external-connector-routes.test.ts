import { describe, expect, it, vi } from 'vitest';
import { externalConnectorRoutes } from '../../runtime-host/api/routes/external-connector-routes';
import { dispatchRuntimeRouteDefinition } from './helpers/runtime-route';

describe('external connector routes', () => {
  it('delegates stable routes to the injected external connector service and sanitizes read responses', async () => {
    const unsafeConnector = {
      id: 'connector-1',
      kind: 'mcp-http',
      url: 'https://mcp.example.com',
      headers: { Authorization: 'Bearer raw-token' },
      secretHeaders: { Authorization: { kind: 'secret-ref', ref: 'secret/header' } },
      secretEnv: { API_TOKEN: { kind: 'secret-ref', ref: 'secret/env' } },
      secretConfigRefs: { password: { kind: 'secret-ref', ref: 'secret/config' } },
      nested: { token: 'nested-token', safe: 'visible' },
    };
    const service = {
      list: vi.fn(async () => ({ status: 200, data: { connectors: [unsafeConnector] } })),
      listMcpServerPrograms: vi.fn(async () => ({ status: 200, data: { programs: [{ id: 'program-1', token: 'program-token' }] } })),
      listConnectionStatuses: vi.fn(async () => ({ status: 200, data: { statuses: [{ connectorId: 'connector-1', resultType: 'connected', secretEnv: { TOKEN: 'raw' } }] } })),
      probeConnectionStatus: vi.fn(async () => ({ status: 200, data: { status: { connectorId: 'connector-1', resultType: 'connected', headers: { Authorization: 'Bearer raw-token' } } } })),
      listSessionDownstreamStatuses: vi.fn(async () => ({ status: 200, data: { statuses: [{ connectorId: 'connector-1', resultType: 'connected', secretConfigRefs: { apiKey: { kind: 'secret-ref', ref: 'secret/api' } } }] } })),
      get: vi.fn(async () => ({ status: 200, data: { connector: unsafeConnector } })),
      upsert: vi.fn(async () => ({ status: 200, data: { success: true, connector: unsafeConnector } })),
      remove: vi.fn(async () => ({ status: 200, data: { success: true, connector: unsafeConnector } })),
    };

    await expect(dispatchRuntimeRouteDefinition(
      externalConnectorRoutes,
      'GET',
      '/api/external-connectors',
      undefined,
      { externalConnectorService: service },
    )).resolves.toEqual({ status: 200, data: { connectors: [{ id: 'connector-1', kind: 'mcp-http', url: 'https://mcp.example.com', nested: { safe: 'visible' } }] } });

    await expect(dispatchRuntimeRouteDefinition(
      externalConnectorRoutes,
      'GET',
      '/api/external-connectors/mcp-server-programs',
      undefined,
      { externalConnectorService: service },
    )).resolves.toEqual({ status: 200, data: { programs: [{ id: 'program-1' }] } });

    await expect(dispatchRuntimeRouteDefinition(
      externalConnectorRoutes,
      'GET',
      '/api/external-connectors/status',
      undefined,
      { externalConnectorService: service },
    )).resolves.toEqual({ status: 200, data: { statuses: [{ connectorId: 'connector-1', resultType: 'connected' }] } });

    await expect(dispatchRuntimeRouteDefinition(
      externalConnectorRoutes,
      'POST',
      '/api/external-connectors/probe',
      { connectorId: 'connector-1' },
      { externalConnectorService: service },
    )).resolves.toEqual({ status: 200, data: { status: { connectorId: 'connector-1', resultType: 'connected' } } });

    await expect(dispatchRuntimeRouteDefinition(
      externalConnectorRoutes,
      'POST',
      '/api/external-connectors/session-status',
      { sessionIdentity: { sessionKey: 'session-1' } },
      { externalConnectorService: service },
    )).resolves.toEqual({ status: 200, data: { statuses: [{ connectorId: 'connector-1', resultType: 'connected' }] } });

    await expect(dispatchRuntimeRouteDefinition(
      externalConnectorRoutes,
      'POST',
      '/api/external-connectors/get',
      { connectorId: 'connector-1' },
      { externalConnectorService: service },
    )).resolves.toEqual({ status: 200, data: { connector: { id: 'connector-1', kind: 'mcp-http', url: 'https://mcp.example.com', nested: { safe: 'visible' } } } });

    await expect(dispatchRuntimeRouteDefinition(
      externalConnectorRoutes,
      'POST',
      '/api/external-connectors/upsert',
      { connector: { id: 'connector-1' } },
      { externalConnectorService: service },
    )).resolves.toEqual({ status: 200, data: { success: true, connector: { id: 'connector-1', kind: 'mcp-http', url: 'https://mcp.example.com', nested: { safe: 'visible' } } } });

    await expect(dispatchRuntimeRouteDefinition(
      externalConnectorRoutes,
      'POST',
      '/api/external-connectors/remove',
      { connectorId: 'connector-1' },
      { externalConnectorService: service },
    )).resolves.toEqual({ status: 200, data: { success: true, connector: { id: 'connector-1', kind: 'mcp-http', url: 'https://mcp.example.com', nested: { safe: 'visible' } } } });

    const readResponses = await Promise.all([
      dispatchRuntimeRouteDefinition(externalConnectorRoutes, 'GET', '/api/external-connectors', undefined, { externalConnectorService: service }),
      dispatchRuntimeRouteDefinition(externalConnectorRoutes, 'GET', '/api/external-connectors/mcp-server-programs', undefined, { externalConnectorService: service }),
      dispatchRuntimeRouteDefinition(externalConnectorRoutes, 'GET', '/api/external-connectors/status', undefined, { externalConnectorService: service }),
      dispatchRuntimeRouteDefinition(externalConnectorRoutes, 'POST', '/api/external-connectors/probe', { connectorId: 'connector-1' }, { externalConnectorService: service }),
      dispatchRuntimeRouteDefinition(externalConnectorRoutes, 'POST', '/api/external-connectors/session-status', { sessionIdentity: { sessionKey: 'session-1' } }, { externalConnectorService: service }),
      dispatchRuntimeRouteDefinition(externalConnectorRoutes, 'POST', '/api/external-connectors/get', { connectorId: 'connector-1' }, { externalConnectorService: service }),
      dispatchRuntimeRouteDefinition(externalConnectorRoutes, 'POST', '/api/external-connectors/upsert', { connector: { id: 'connector-1' } }, { externalConnectorService: service }),
      dispatchRuntimeRouteDefinition(externalConnectorRoutes, 'POST', '/api/external-connectors/remove', { connectorId: 'connector-1' }, { externalConnectorService: service }),
    ]);
    const readResponseJson = JSON.stringify(readResponses);
    expect(readResponseJson).not.toContain('raw-token');
    expect(readResponseJson).not.toContain('nested-token');
    expect(readResponseJson).not.toContain('program-token');
    expect(readResponseJson).not.toContain('secret/header');
    expect(readResponseJson).not.toContain('secret/env');
    expect(readResponseJson).not.toContain('secret/config');
    expect(readResponseJson).not.toContain('secret/api');
    expect(readResponseJson).not.toContain('headers');
    expect(readResponseJson).not.toContain('secretHeaders');
    expect(readResponseJson).not.toContain('secretEnv');
    expect(readResponseJson).not.toContain('secretConfigRefs');
    expect(readResponseJson).not.toContain('token');

    expect(service.list).toHaveBeenCalledTimes(2);
    expect(service.listMcpServerPrograms).toHaveBeenCalledTimes(2);
    expect(service.listConnectionStatuses).toHaveBeenCalledTimes(2);
    expect(service.probeConnectionStatus).toHaveBeenCalledWith({ connectorId: 'connector-1' });
    expect(service.probeConnectionStatus).toHaveBeenCalledTimes(2);
    expect(service.listSessionDownstreamStatuses).toHaveBeenCalledWith({ sessionIdentity: { sessionKey: 'session-1' } });
    expect(service.listSessionDownstreamStatuses).toHaveBeenCalledTimes(2);
    expect(service.get).toHaveBeenCalledWith({ connectorId: 'connector-1' });
    expect(service.get).toHaveBeenCalledTimes(2);
    expect(service.upsert).toHaveBeenCalledWith({ connector: { id: 'connector-1' } });
    expect(service.upsert).toHaveBeenCalledTimes(2);
    expect(service.remove).toHaveBeenCalledWith({ connectorId: 'connector-1' });
    expect(service.remove).toHaveBeenCalledTimes(2);
  });
});
