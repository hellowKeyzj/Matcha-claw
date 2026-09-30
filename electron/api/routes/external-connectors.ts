import type { IncomingMessage, ServerResponse } from 'http';
import type { ExternalConnectorsTransport } from '../../main/runtime-host-delivery/transport/connectors/external';
import { validateSessionIdentity } from '../../../src/types/desktop/runtime-address';
import { parseJsonBody, sendJson } from '../route-utils';

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
  | 'externalConnectors.get'
  | 'externalConnectors.upsert'
  | 'externalConnectors.remove';

export async function handleExternalConnectorsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  transport: ExternalConnectorsTransport,
): Promise<boolean> {
  if (url.pathname === '/api/external-connectors/session-status' && req.method === 'POST') {
    const body = await parseLegacyBody(req, res);
    if (!body) return true;
    if (!hasExactKeys(body, ['sessionIdentity']) || validateSessionIdentity(body.sessionIdentity)) {
      sendJson(res, 400, INVALID);
      return true;
    }
    await deliver(transport, res, createRequest('externalConnectors.sessionStatus', {
      kind: 'sessionStatus',
      sessionIdentity: body.sessionIdentity,
    }));
    return true;
  }

  if (url.pathname === '/api/external-connectors/session-mcp-server-enabled' && req.method === 'POST') {
    const body = await parseLegacyBody(req, res);
    if (!body) return true;
    if (!hasExactKeys(body, ['sessionIdentity', 'serverId', 'enabled'])
      || validateSessionIdentity(body.sessionIdentity)
      || !isConnectorId(body.serverId)
      || typeof body.enabled !== 'boolean') {
      sendJson(res, 400, INVALID);
      return true;
    }
    await deliver(transport, res, createRequest('externalConnectors.sessionMcpServerEnabled', {
      kind: 'sessionMcpServerEnabled',
      sessionIdentity: body.sessionIdentity,
      serverId: body.serverId,
      enabled: body.enabled,
    }));
    return true;
  }

  if (url.pathname === '/api/external-connectors' && req.method === 'GET') {
    await deliver(transport, res, createRequest('externalConnectors.list', { kind: 'list' }));
    return true;
  }
  if (url.pathname === '/api/external-connectors/mcp-server-programs' && req.method === 'GET') {
    await deliver(transport, res, createRequest('externalConnectors.catalog', { kind: 'catalog' }));
    return true;
  }
  if (url.pathname === '/api/external-connectors/status' && req.method === 'GET') {
    await deliver(transport, res, createRequest('externalConnectors.status', { kind: 'status' }));
    return true;
  }

  if (url.pathname === '/api/external-connectors' && req.method === 'POST') {
    let body: unknown;
    try {
      body = await parseJsonBody(req);
    } catch {
      sendJson(res, 400, INVALID);
      return true;
    }
    await deliver(transport, res, body);
    return true;
  }

  if (url.pathname === '/api/external-connectors/get' && req.method === 'POST') {
    const body = await parseLegacyBody(req, res);
    if (!body) return true;
    if (!hasExactKeys(body, ['connectorId']) || !isConnectorId(body.connectorId)) {
      sendJson(res, 400, INVALID);
      return true;
    }
    await deliver(transport, res, createRequest('externalConnectors.get', {
      kind: 'get',
      connectorId: body.connectorId,
    }));
    return true;
  }

  if (url.pathname === '/api/external-connectors/observation-result' && req.method === 'POST') {
    const body = await parseLegacyBody(req, res);
    if (!body) return true;
    if (!(hasExactKeys(body, ['callId'])
      || (hasExactKeys(body, ['callId', 'sessionIdentity']) && !validateSessionIdentity(body.sessionIdentity)))
      || typeof body.callId !== 'string' || !/^[a-f0-9]{32}$/.test(body.callId)) {
      sendJson(res, 400, INVALID);
      return true;
    }
    await deliver(transport, res, createRequest('externalConnectors.observationResult', {
      kind: 'observationResult', callId: body.callId,
      ...(body.sessionIdentity === undefined ? {} : { sessionIdentity: body.sessionIdentity }),
    }));
    return true;
  }

  if (url.pathname === '/api/external-connectors/probe' && req.method === 'POST') {
    const body = await parseLegacyBody(req, res);
    if (!body) return true;
    if (!hasExactKeys(body, ['connectorId']) || !isConnectorId(body.connectorId)) {
      sendJson(res, 400, INVALID);
      return true;
    }
    await deliver(transport, res, createRequest('externalConnectors.probe', {
      kind: 'probe',
      connectorId: body.connectorId,
    }));
    return true;
  }

  if (url.pathname === '/api/external-connectors/upsert' && req.method === 'POST') {
    const body = await parseLegacyBody(req, res);
    if (!body) return true;
    if (!hasExactKeys(body, ['connector'])) {
      sendJson(res, 400, INVALID);
      return true;
    }
    await deliver(transport, res, createRequest('externalConnectors.upsert', {
      kind: 'upsert',
      connector: body.connector,
    }));
    return true;
  }

  if (url.pathname === '/api/external-connectors/remove' && req.method === 'POST') {
    const body = await parseLegacyBody(req, res);
    if (!body) return true;
    if (!hasExactKeys(body, ['connectorId']) || !isConnectorId(body.connectorId)) {
      sendJson(res, 400, INVALID);
      return true;
    }
    await deliver(transport, res, createRequest('externalConnectors.remove', {
      kind: 'remove',
      connectorId: body.connectorId,
    }));
    return true;
  }

  return false;
}

function createRequest(operationId: ExternalConnectorOperation, input: Record<string, unknown>) {
  return {
    id: 'external.connectors',
    operationId,
    scope: { kind: 'external-connector-catalog' },
    target: { kind: 'external-connectors' },
    input,
  };
}

async function parseLegacyBody(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  let body: unknown;
  try {
    body = await parseJsonBody(req);
  } catch {
    sendJson(res, 400, INVALID);
    return null;
  }
  if (!isRecord(body)) {
    sendJson(res, 400, INVALID);
    return null;
  }
  return body;
}

async function deliver(
  transport: ExternalConnectorsTransport,
  res: ServerResponse,
  request: unknown,
): Promise<void> {
  try {
    const response = await transport.execute(request);
    sendJson(res, response.status, response.body);
  } catch {
    sendJson(res, 503, UNAVAILABLE);
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
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128;
}
