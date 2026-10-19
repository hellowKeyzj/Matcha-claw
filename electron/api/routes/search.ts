import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SearchVerifyRequest } from '../../../src/types/network-search';
import type { SearchConfigRequest, SearchTransport } from '../../main/runtime-host-delivery/transport/search';
import { parseJsonBody, sendJson } from '../route-utils';

const INVALID = { success: false, error: 'Network search request is invalid' } as const;
const UNAVAILABLE = { success: false, error: 'Network search is unavailable; prepare or restart the service' } as const;

export async function handleSearchRoutes(
  req: IncomingMessage, res: ServerResponse, url: URL, transport: SearchTransport,
): Promise<boolean> {
  const path = url.pathname;
  if (!((path === '/api/search' || path === '/api/search/logs') && req.method === 'GET')
    && !(path === '/api/search/config' && req.method === 'PUT')
    && !(['/api/search/prepare', '/api/search/restart', '/api/search/verify', '/api/search/stop'].includes(path) && req.method === 'POST')) return false;
  const controller = new AbortController();
  const onClose = () => { if (!res.writableEnded) controller.abort(); };
  res.once('close', onClose);
  try {
    if (url.search) { sendJson(res, 400, INVALID); return true; }
    let body: unknown;
    if (path === '/api/search/config' || path === '/api/search/verify') {
      try { body = await parseJsonBody(req); } catch { sendJson(res, 400, INVALID); return true; }
    }
    // The Rust owner is the single functional validation boundary; this route never edits or normalizes its input.
    const response = path === '/api/search' ? await transport.read(controller.signal)
      : path === '/api/search/config' ? await transport.configure(body as SearchConfigRequest, controller.signal)
      : path === '/api/search/prepare' ? await transport.prepare(controller.signal)
      : path === '/api/search/restart' ? await transport.restart(controller.signal)
      : path === '/api/search/verify' ? await transport.verify(body as SearchVerifyRequest, controller.signal)
      : path === '/api/search/stop' ? await transport.stop(controller.signal)
      : await transport.logs(controller.signal);
    if (!controller.signal.aborted) sendJson(res, response.status, response.body);
  } catch {
    if (!controller.signal.aborted) sendJson(res, 503, UNAVAILABLE);
  } finally {
    res.off('close', onClose);
  }
  return true;
}
