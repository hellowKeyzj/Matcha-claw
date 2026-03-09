import type { IncomingMessage, ServerResponse } from 'http';
import { getRecentTokenUsageHistory } from '../../utils/token-usage';
import type { HostApiContext } from '../context';
import { sendJson } from '../route-utils';

export async function handleUsageRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  _ctx: HostApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/usage/recent-token-history' && req.method === 'GET') {
    const parsedLimit = Number(url.searchParams.get('limit') || '');
    const limit = Number.isFinite(parsedLimit) ? Math.max(Math.floor(parsedLimit), 1) : undefined;
    sendJson(res, 200, await getRecentTokenUsageHistory(limit));
    return true;
  }

  return false;
}
