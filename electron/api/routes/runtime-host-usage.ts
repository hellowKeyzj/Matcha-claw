import { jsonResult, type HostApiRequest, type HostApiRouteResult } from '../execution';
import type { UsageTransport } from '../../main/runtime-host-delivery/transport/usage';
import { readRuntimeScopeQuery } from '../../main/runtime-host-delivery/transport/runtime-scope';

const UNAVAILABLE = {
  success: false,
  error: 'OpenClaw usage history is unavailable',
} as const;

export async function handleRuntimeHostUsageRoutes(
  req: HostApiRequest,
  url: URL,
  transport: UsageTransport,
): Promise<HostApiRouteResult> {
  if (req.method !== 'GET') {
    return undefined;
  }
  if (url.pathname !== '/api/runtime-host/usage/recent' && url.pathname !== '/api/runtime-host/usage/session-timeseries') {
    return undefined;
  }

  const rawLimit = url.searchParams.get('limit');
  const limit = rawLimit === null ? undefined : Number(rawLimit);
  try {
    const response = url.pathname === '/api/runtime-host/usage/recent'
      ? await transport.read(limit, readRuntimeScopeQuery(url.searchParams))
      : await transport.readSessionTimeseries({
        sessionId: url.searchParams.get('sessionId') ?? '',
        agentId: url.searchParams.get('agentId') ?? '',
        scope: readRuntimeScopeQuery(url.searchParams),
      });
    return jsonResult(response.status, response.body);
  } catch {
    return jsonResult(503, UNAVAILABLE);
  }
}
