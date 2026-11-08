import type { createInterconnect } from '../../main/interconnect';
import type { CapabilityCall, InterconnectCommand, InterconnectFailure } from '../../../src/types/desktop/interconnect';
import { jsonResult, type HostApiRequest, type HostApiRouteResult } from '../execution';

export async function handleInterconnectRoutes(
  request: HostApiRequest, url: URL, interconnect: Awaited<ReturnType<typeof createInterconnect>>,
): Promise<HostApiRouteResult> {
  const read = request.method === 'GET' && url.pathname === '/api/interconnect';
  const action = request.method === 'POST' ? {
    '/api/interconnect/command': 'command',
    '/api/interconnect/discover': 'discover',
    '/api/interconnect/invoke': 'invoke',
    '/api/interconnect/result': 'result',
  }[url.pathname] : undefined;
  if (!read && !action) return undefined;
  if (request.signal.aborted) return null;
  const fail = (status: number, error: string) => jsonResult(status, { success: false, error });
  if (url.search) return fail(400, 'invalid-request');
  let preview = false;
  try {
    let result: unknown;
    if (read) result = await interconnect.read();
    else {
      let body: Record<string, unknown>;
      try {
        const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await request.readBytes(65_536, true)));
        if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(400, 'invalid-request');
        body = value as Record<string, unknown>;
      } catch { return request.signal.aborted ? null : fail(400, 'invalid-request'); }
      switch (action) {
        case 'command':
          preview = body.kind === 'connect.preview';
          result = await interconnect.command(body as unknown as InterconnectCommand); break;
        case 'discover':
          if (Object.keys(body).length !== 1 || typeof body.clientId !== 'string') return fail(400, 'invalid-request');
          result = await interconnect.discover(body.clientId, request.signal); break;
        case 'invoke': result = await interconnect.invoke(body as unknown as CapabilityCall, request.signal); break;
        case 'result':
          if (Object.keys(body).length !== 2 || typeof body.clientId !== 'string' || typeof body.callId !== 'string') return fail(400, 'invalid-request');
          result = await interconnect.result(body.clientId, body.callId, request.signal); break;
      }
    }
    if (request.signal.aborted) return null;
    if (result && typeof result === 'object' && 'success' in result && result.success === false) {
      const { error } = result as InterconnectFailure;
      return fail(({ 'invalid-request': 400, unauthorized: 401, forbidden: 403, 'not-found': 404, conflict: 409, 'network-change-required': 409 } as Record<string, number>)[error] ?? 503, error);
    }
    return jsonResult(200, result);
  } catch { return request.signal.aborted ? null : fail(503, !preview && (action === 'command' || action === 'invoke') ? 'outcome-unknown' : 'unavailable'); }
}
