import type { AgentsTransport } from '../../main/runtime-host-delivery/products/agents';
import { jsonResult, type HostApiRequest, type HostApiRouteResult } from '../execution';

const INVALID = {
  success: false,
  error: 'Subagent management request is invalid',
} as const;
const UNAVAILABLE = {
  success: false,
  error: 'Subagent management is unavailable',
} as const;

export async function handleAgentsRoutes(
  req: HostApiRequest,
  url: URL,
  transport: AgentsTransport,
): Promise<HostApiRouteResult> {
  const result = url.pathname === '/api/subagents/results';
  if ((!result && url.pathname !== '/api/subagents/agents') || req.method !== 'POST') return undefined;

  let request: unknown;
  try {
    request = await req.readJson<unknown>();
  } catch {
    return jsonResult(400, INVALID);
  }

  try {
    const response = result ? await transport.result(request) : await transport.execute(request);
    return jsonResult(response.status, result ? response.body : publicAgentsBody(request, response.body));
  } catch {
    return jsonResult(503, UNAVAILABLE);
  }
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
