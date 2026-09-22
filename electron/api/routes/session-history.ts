import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RuntimeHostTransportContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';

const UNAVAILABLE = {
  success: false,
  error: 'Session history is unavailable',
} as const;

type SessionHistoryRouteDeps = RuntimeHostTransportContext<'sessionHistoryTransport'>;

export async function handleSessionHistoryRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: SessionHistoryRouteDeps,
): Promise<boolean> {
  if (req.method !== 'POST') return false;

  if (url.pathname !== '/api/sessions/history') return false;
  const transport = deps.runtimeHostTransports.sessionHistoryTransport;

  let request: unknown;
  try {
    request = await parseJsonBody<unknown>(req);
  } catch {
    request = undefined;
  }

  try {
    const response = await transport.read(request);
    sendJson(res, response.status, response.body);
  } catch {
    sendJson(res, 503, UNAVAILABLE);
  }
  return true;
}
