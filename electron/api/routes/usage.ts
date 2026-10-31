import { jsonResult, type HostApiRequest, type HostApiRouteResult } from '../execution';
import type { UsageTransport } from '../../main/runtime-host-delivery/transport/usage';
import { readRuntimeScopeQuery } from '../../main/runtime-host-delivery/transport/runtime-scope';

const UNAVAILABLE = {
  success: false,
  error: 'OpenClaw usage history is unavailable',
} as const;

export async function handleUsageRoutes(
  req: HostApiRequest,
  url: URL,
  transport: UsageTransport,
): Promise<HostApiRouteResult> {
  if (url.pathname !== '/api/usage/recent' || req.method !== 'GET') return undefined;

  const rawLimit = url.searchParams.get('limit');
  const limit = rawLimit === null ? undefined : Number(rawLimit);
  try {
    const response = await transport.read(limit, readRuntimeScopeQuery(url.searchParams));
    return jsonResult(response.status, response.body);
  } catch {
    return jsonResult(503, UNAVAILABLE);
  }
}
