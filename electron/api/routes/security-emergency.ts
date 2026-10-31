import { jsonResult, type HostApiRequest, type HostApiRouteResult } from '../execution';
import type { SecurityEmergencyTransport } from '../../main/runtime-host-delivery/transport/security/emergency';

const INVALID = {
  success: false,
  error: 'Security emergency request is invalid',
} as const;
const UNAVAILABLE = {
  success: false,
  error: 'Security emergency is unavailable',
} as const;

export async function handleSecurityEmergencyRoutes(
  req: HostApiRequest,
  url: URL,
  transport: SecurityEmergencyTransport,
): Promise<HostApiRouteResult> {
  if (url.pathname !== '/api/security/emergency' || req.method !== 'POST') return undefined;

  let body: unknown;
  try {
    body = await req.readJson();
  } catch {
    return jsonResult(400, INVALID);
  }
  if (!isEmptyObject(body)) {
    return jsonResult(400, INVALID);
  }
  try {
    const response = await transport.run();
    return jsonResult(response.status, response.body);
  } catch {
    return jsonResult(503, UNAVAILABLE);
  }
}

function isEmptyObject(value: unknown): value is Record<string, never> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
}
