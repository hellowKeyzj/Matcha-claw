import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  UsageHistoryEntry,
  UsageTransport,
} from '../../main/runtime-host-delivery/transport/usage';
import { sendJson } from '../route-utils';

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
  if (url.pathname !== '/api/runtime-host/usage/recent' || req.method !== 'GET') {
    return false;
  }

  const rawLimit = url.searchParams.get('limit');
  const limit = rawLimit === null ? undefined : Number(rawLimit);
  try {
    const response = await transport.read(limit);
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
  body: Readonly<{ entries: readonly UsageHistoryEntry[] }> | typeof UNAVAILABLE,
): body is Readonly<{ entries: readonly UsageHistoryEntry[] }> {
  return 'entries' in body;
}
