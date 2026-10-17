import type { IncomingMessage, ServerResponse } from 'node:http';
import type { UsageTransport } from '../../main/runtime-host-delivery/transport/usage';
import { sendJson } from '../route-utils';
import { readRuntimeScopeQuery } from '../../main/runtime-host-delivery/transport/runtime-scope';

const UNAVAILABLE = {
  success: false,
  error: 'OpenClaw usage history is unavailable',
} as const;

export async function handleUsageRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  transport: UsageTransport,
): Promise<boolean> {
  if (url.pathname !== '/api/usage/recent' || req.method !== 'GET') return false;

  const rawLimit = url.searchParams.get('limit');
  const limit = rawLimit === null ? undefined : Number(rawLimit);
  try {
    const response = await transport.read(limit, readRuntimeScopeQuery(url.searchParams));
    sendJson(res, response.status, response.body);
  } catch {
    sendJson(res, 503, UNAVAILABLE);
  }
  return true;
}
