import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AgentsTransport } from '../../main/runtime-host-delivery/products/agents';
import { parseJsonBody, sendJson } from '../route-utils';

const INVALID = {
  success: false,
  error: 'Subagent management request is invalid',
} as const;
const UNAVAILABLE = {
  success: false,
  error: 'Subagent management is unavailable',
} as const;

export async function handleAgentsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  transport: AgentsTransport,
): Promise<boolean> {
  const result = url.pathname === '/api/subagents/results';
  if ((!result && url.pathname !== '/api/subagents/agents') || req.method !== 'POST') return false;

  let request: unknown;
  try {
    request = await parseJsonBody<unknown>(req);
  } catch {
    sendJson(res, 400, INVALID);
    return true;
  }

  try {
    const response = result ? await transport.result(request) : await transport.execute(request);
    sendJson(res, response.status, result ? response.body : publicAgentsBody(request, response.body));
  } catch {
    sendJson(res, 503, UNAVAILABLE);
  }
  return true;
}

function publicAgentsBody(request: unknown, body: unknown): unknown {
  if (!isRecord(request)
    || request.operationId !== 'subagents.package.install'
    || !isRecord(body)
    || !isRecord(body.package)) {
    return body;
  }
  const {
    packagePath: _packagePath,
    authorizationKey: _authorizationKey,
    deviceEnvelope: _deviceEnvelope,
    contentKey: _contentKey,
    rawPayload: _rawPayload,
    token: _token,
    ...publicPackage
  } = body.package;
  return { ...body, package: publicPackage };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
