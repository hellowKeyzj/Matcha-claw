import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CallLogTransport } from '../../main/runtime-host-delivery/transport/call-log';
import { parseJsonBody, sendJson } from '../route-utils';

export async function handleCallRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  transport: CallLogTransport,
): Promise<boolean> {
  if (req.method !== 'POST') return false;
  const operation = url.pathname === '/api/calls/list' ? 'list'
    : url.pathname === '/api/calls/get' ? 'get'
      : url.pathname === '/api/calls/history' ? 'history' : null;
  if (!operation) return false;
  let body: unknown;
  try {
    body = await parseJsonBody<unknown>(req);
  } catch {
    sendJson(res, 400, { success: false, error: 'Call log input is invalid' });
    return true;
  }
  try {
    const response = await transport[operation](body);
    sendJson(res, response.status, response.body);
  } catch {
    sendJson(res, 503, { success: false, error: 'Call log is unavailable' });
  }
  return true;
}
