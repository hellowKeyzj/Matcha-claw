import type { createNetworkAccess } from '../../main/network-access';
import type { NetworkRequest } from '../../../src/types/desktop/network-access';
import { jsonResult, type HostApiRequest, type HostApiRouteResult } from '../execution';

type NetworkAccess = Awaited<ReturnType<typeof createNetworkAccess>>;

export async function handleAccessNetworkRoutes(
  request: HostApiRequest, url: URL, network: NetworkAccess,
): Promise<HostApiRouteResult> {
  if (!(request.method === 'GET' && url.pathname === '/api/access-network')
    && !(request.method === 'POST' && url.pathname === '/api/access-network/command')) return undefined;
  if (request.signal.aborted) return null;
  if (url.search) return jsonResult(400, { success: false, error: 'invalid-request' });
  try {
    if (request.method === 'GET') return jsonResult(200, await network.read());
    let command: NetworkRequest;
    try {
      command = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await request.readBytes(65_536, true))) as NetworkRequest;
    } catch {
      return request.signal.aborted ? null : jsonResult(400, { success: false, error: 'invalid-request' });
    }
    const result = await network.command(command);
    if (request.signal.aborted) return null;
    const status = 'success' in result ? result.error === 'invalid-request' ? 400 : result.error === 'conflict' ? 409 : 503 : 200;
    return jsonResult(status, result);
  } catch {
    return request.signal.aborted ? null : jsonResult(503, { success: false, error: 'unavailable' });
  }
}
