import type { SearchVerifyRequest } from '../../../src/types/network-search';
import type { SearchConfigRequest, SearchTransport } from '../../main/runtime-host-delivery/transport/search';
import { jsonResult, type HostApiRequest, type HostApiRouteResult } from '../execution';

const INVALID = { success: false, error: 'Network search request is invalid' } as const;
const UNAVAILABLE = { success: false, error: 'Network search is unavailable; prepare or restart the service' } as const;

export async function handleSearchRoutes(
  req: HostApiRequest, url: URL, transport: SearchTransport,
): Promise<HostApiRouteResult> {
  const path = url.pathname;
  if (!((path === '/api/search' || path === '/api/search/logs') && req.method === 'GET')
    && !(path === '/api/search/config' && req.method === 'PUT')
    && !(['/api/search/prepare', '/api/search/restart', '/api/search/verify', '/api/search/stop'].includes(path) && req.method === 'POST')) return undefined;
  try {
    if (url.search) return jsonResult(400, INVALID);
    let body: unknown;
    if (path === '/api/search/config' || path === '/api/search/verify') {
      try { body = await req.readJson(); } catch { return req.signal.aborted ? null : jsonResult(400, INVALID); }
    }
    // The Rust owner is the single functional validation boundary; this route never edits or normalizes its input.
    const response = path === '/api/search' ? await transport.read(req.signal)
      : path === '/api/search/config' ? await transport.configure(body as SearchConfigRequest, req.signal)
      : path === '/api/search/prepare' ? await transport.prepare(req.signal)
      : path === '/api/search/restart' ? await transport.restart(req.signal)
      : path === '/api/search/verify' ? await transport.verify(body as SearchVerifyRequest, req.signal)
      : path === '/api/search/stop' ? await transport.stop(req.signal)
      : await transport.logs(req.signal);
    return req.signal.aborted ? null : jsonResult(response.status, response.body);
  } catch {
    return req.signal.aborted ? null : jsonResult(503, UNAVAILABLE);
  }
}
