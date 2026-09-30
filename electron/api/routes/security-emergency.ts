import type { IncomingMessage, ServerResponse } from 'http';
import type { SecurityEmergencyTransport } from '../../main/runtime-host-delivery/transport/security/emergency';
import { parseJsonBody, sendJson } from '../route-utils';

const INVALID = {
  success: false,
  error: 'Security emergency request is invalid',
} as const;
const UNAVAILABLE = {
  success: false,
  error: 'Security emergency is unavailable',
} as const;

export async function handleSecurityEmergencyRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  transport: SecurityEmergencyTransport,
): Promise<boolean> {
  if (url.pathname !== '/api/security/emergency' || req.method !== 'POST') return false;

  let body: unknown;
  try {
    body = await parseJsonBody(req);
  } catch {
    sendJson(res, 400, INVALID);
    return true;
  }
  if (!isEmptyObject(body)) {
    sendJson(res, 400, INVALID);
    return true;
  }
  try {
    const response = await transport.run();
    sendJson(res, response.status, response.body);
  } catch {
    sendJson(res, 503, UNAVAILABLE);
  }
  return true;
}

function isEmptyObject(value: unknown): value is Record<string, never> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
}
