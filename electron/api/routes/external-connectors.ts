import { jsonResult, type HostApiRequest, type HostApiResponse, type HostApiRouteResult } from '../execution';
import { isConnectorOAuthScope, type ExternalConnectorsTransport } from '../../main/runtime-host-delivery/transport/connectors/external';
import { validateSessionIdentity } from '../../../src/types/desktop/runtime-address';
import { isConnectorOAuthInput } from '../../../src/types/connectors-oauth';
import { isProductRuntimeScope, readRuntimeScopeQuery } from '../../main/runtime-host-delivery/transport/runtime-scope';

const INVALID = {
  success: false,
  error: 'External connector request is invalid',
} as const;
const UNAVAILABLE = {
  success: false,
  error: 'External connectors are unavailable',
} as const;
type ExternalConnectorOperation =
  | 'externalConnectors.list'
  | 'externalConnectors.catalog'
  | 'externalConnectors.status'
  | 'externalConnectors.observationResult'
  | 'externalConnectors.sessionStatus'
  | 'externalConnectors.sessionMcpServerEnabled'
  | 'externalConnectors.probe'
  | 'externalConnectors.oauth'
  | 'externalConnectors.get'
  | 'externalConnectors.upsert'
  | 'externalConnectors.update'
  | 'externalConnectors.remove';

export async function handleExternalConnectorsRoutes(
  req: HostApiRequest,
  url: URL,
  transport: ExternalConnectorsTransport,
): Promise<HostApiRouteResult> {
  if (url.pathname === '/api/external-connectors/session-status' && req.method === 'POST') {
    const [body, invalid] = await parseLegacyBody(req);
    if (!body) return invalid;
    if (!hasExactKeys(body, ['sessionIdentity']) || validateSessionIdentity(body.sessionIdentity)) {
      return jsonResult(400, INVALID);
    }
    return deliver(transport, createRequest('externalConnectors.sessionStatus', {
      kind: 'sessionStatus',
      sessionIdentity: body.sessionIdentity,
    }));
  }

  if (url.pathname === '/api/external-connectors/session-mcp-server-enabled' && req.method === 'POST') {
    const [body, invalid] = await parseLegacyBody(req);
    if (!body) return invalid;
    if (!hasExactKeys(body, ['sessionIdentity', 'serverId', 'enabled'])
      || validateSessionIdentity(body.sessionIdentity)
      || !isConnectorId(body.serverId)
      || typeof body.enabled !== 'boolean') {
      return jsonResult(400, INVALID);
    }
    return deliver(transport, createRequest('externalConnectors.sessionMcpServerEnabled', {
      kind: 'sessionMcpServerEnabled',
      sessionIdentity: body.sessionIdentity,
      serverId: body.serverId,
      enabled: body.enabled,
    }));
  }

  if (url.pathname === '/api/external-connectors' && req.method === 'GET') {
    return deliver(transport, createRequest('externalConnectors.list', { kind: 'list' }));
  }
  if (url.pathname === '/api/external-connectors/mcp-server-programs' && req.method === 'GET') {
    return deliver(transport, createRequest('externalConnectors.catalog', { kind: 'catalog' }));
  }
  if (url.pathname === '/api/external-connectors/status' && req.method === 'GET') {
    return deliver(transport, createRequest('externalConnectors.status', { kind: 'status' }, readRuntimeScopeQuery(url.searchParams)));
  }

  if (url.pathname === '/api/external-connectors' && req.method === 'POST') {
    let body: unknown;
    try {
      body = await req.readJson();
    } catch {
      return jsonResult(400, INVALID);
    }
    return deliver(transport, body);
  }

  if (url.pathname === '/api/external-connectors/get' && req.method === 'POST') {
    const [body, invalid] = await parseLegacyBody(req);
    if (!body) return invalid;
    if (!hasExactKeys(body, ['connectorId']) || !isConnectorId(body.connectorId)) {
      return jsonResult(400, INVALID);
    }
    return deliver(transport, createRequest('externalConnectors.get', {
      kind: 'get',
      connectorId: body.connectorId,
    }));
  }

  if (url.pathname === '/api/external-connectors/oauth' && req.method === 'POST') {
    const [body, invalid] = await parseLegacyBody(req);
    if (!body) return invalid;
    const { scope, ...input } = body;
    if (Object.hasOwn(input, 'kind') || !isConnectorOAuthInput(input) || !isConnectorOAuthScope(scope, input.agentId)) {
      return jsonResult(400, INVALID);
    }
    return deliver(transport, createRequest('externalConnectors.oauth', { kind: 'oauth', ...input }, scope));
  }

  if (url.pathname === '/api/external-connectors/observation-result' && req.method === 'POST') {
    const [body, invalid] = await parseLegacyBody(req);
    if (!body) return invalid;
    if (!(hasExactKeys(body, ['callId'])
      || (hasExactKeys(body, ['callId', 'scope']) && isProductRuntimeScope(body.scope))
      || (hasExactKeys(body, ['callId', 'scope', 'agentId']) && isConnectorOAuthScope(body.scope, body.agentId))
      || (hasExactKeys(body, ['callId', 'sessionIdentity']) && !validateSessionIdentity(body.sessionIdentity)))
      || typeof body.callId !== 'string' || !/^[a-f0-9]{32}$/.test(body.callId)) {
      return jsonResult(400, INVALID);
    }
    return deliver(transport, createRequest('externalConnectors.observationResult', {
      kind: 'observationResult', callId: body.callId,
      ...(body.sessionIdentity === undefined ? {} : { sessionIdentity: body.sessionIdentity }),
      ...(body.agentId === undefined ? {} : { agentId: body.agentId }),
    }, body.scope));
  }

  if (url.pathname === '/api/external-connectors/probe' && req.method === 'POST') {
    const [body, invalid] = await parseLegacyBody(req);
    if (!body) return invalid;
    if (!(hasExactKeys(body, ['connectorId'])
      || (hasExactKeys(body, ['connectorId', 'scope']) && isProductRuntimeScope(body.scope))) || !isConnectorId(body.connectorId)) {
      return jsonResult(400, INVALID);
    }
    return deliver(transport, createRequest('externalConnectors.probe', {
      kind: 'probe',
      connectorId: body.connectorId,
    }, body.scope));
  }

  if (url.pathname === '/api/external-connectors/upsert' && req.method === 'POST') {
    const [body, invalid] = await parseLegacyBody(req);
    if (!body) return invalid;
    if (!hasExactKeys(body, ['connector'])) {
      return jsonResult(400, INVALID);
    }
    return deliver(transport, createRequest('externalConnectors.upsert', {
      kind: 'upsert',
      connector: body.connector,
    }));
  }

  if (url.pathname === '/api/external-connectors/update' && req.method === 'POST') {
    const [body, invalid] = await parseLegacyBody(req);
    if (!body) return invalid;
    if (!hasExactKeys(body, ['connectorId', 'patch']) || !isConnectorId(body.connectorId) || !isRecord(body.patch)) {
      return jsonResult(400, INVALID);
    }
    return deliver(transport, createRequest('externalConnectors.update', {
      kind: 'update', connectorId: body.connectorId, patch: body.patch,
    }));
  }

  if (url.pathname === '/api/external-connectors/remove' && req.method === 'POST') {
    const [body, invalid] = await parseLegacyBody(req);
    if (!body) return invalid;
    if (!hasExactKeys(body, ['connectorId']) || !isConnectorId(body.connectorId)) {
      return jsonResult(400, INVALID);
    }
    return deliver(transport, createRequest('externalConnectors.remove', {
      kind: 'remove',
      connectorId: body.connectorId,
    }));
  }

  return undefined;
}

function createRequest(operationId: ExternalConnectorOperation, input: Record<string, unknown>, scope?: unknown) {
  const runtimeObservation = operationId === 'externalConnectors.status' || operationId === 'externalConnectors.probe' || operationId === 'externalConnectors.oauth'
    || (operationId === 'externalConnectors.observationResult' && !Object.hasOwn(input, 'sessionIdentity'));
  return {
    id: 'external.connectors',
    operationId,
    scope: runtimeObservation
      ? scope === undefined ? { kind: 'runtime-instance', endpoint: {
        kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local',
      } } : scope
      : { kind: 'external-connector-catalog' },
    target: { kind: 'external-connectors' },
    input,
  };
}

async function parseLegacyBody(
  req: HostApiRequest,
): Promise<readonly [Record<string, unknown>, null] | readonly [null, HostApiResponse]> {
  let body: unknown;
  try {
    body = await req.readJson();
  } catch {
    return [null, jsonResult(400, INVALID)];
  }
  if (!isRecord(body)) {
    return [null, jsonResult(400, INVALID)];
  }
  return [body, null];
}

async function deliver(
  transport: ExternalConnectorsTransport,
  request: unknown,
): Promise<HostApiRouteResult> {
  try {
    const response = await transport.execute(request);
    return jsonResult(response.status, response.body);
  } catch {
    return jsonResult(503, UNAVAILABLE);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isConnectorId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128
    && !/\p{Cc}/u.test(value);
}
