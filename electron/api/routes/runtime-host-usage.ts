import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  UsageHistoryEntry,
  UsageTransport,
  UsageTransportResponse,
} from '../../main/runtime-host-delivery/transport/usage';
import { sendJson } from '../route-utils';
import { readRuntimeScopeQuery } from '../../main/runtime-host-delivery/transport/runtime-scope';

const UNAVAILABLE = {
  success: false,
  error: 'OpenClaw usage history is unavailable',
} as const;

export async function handleRuntimeHostUsageRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  transport: UsageTransport,
): Promise<boolean> {
  if (req.method !== 'GET') {
    return false;
  }
  if (url.pathname !== '/api/runtime-host/usage/recent' && url.pathname !== '/api/runtime-host/usage/session-timeseries') {
    return false;
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
    if (response.status === 200 && isUsageEntries(response.body)) {
      sendJson(res, 200, response.body.entries);
    } else {
      sendJson(res, response.status, response.body);
    }
  } catch {
    sendJson(res, 503, UNAVAILABLE);
  }
  return true;
}

function isUsageEntries(
  body: UsageTransportResponse['body'],
): body is Readonly<{ entries: readonly UsageHistoryEntry[] }> {
  return 'entries' in body;
}
