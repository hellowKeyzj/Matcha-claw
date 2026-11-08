import type { AccessCommand } from '../../../src/types/resource-access';
import type { NetworkErrorCode, NetworkSnapshot } from '../../../src/types/desktop/network-access';
import type { AccessOwner } from '../../main/access';
import { jsonResult, type HostApiRequest, type HostApiRouteResult } from '../execution';

const INVALID = { success: false, error: 'invalid-request' } as const;
const UNAVAILABLE = { success: false, error: 'unavailable' } as const;
const UNKNOWN = { success: false, error: 'outcome-unknown' } as const;

export async function handleAccessRoutes(
  req: HostApiRequest, url: URL, access: AccessOwner,
  resolveCapability: (sourceId: string) => Promise<boolean>,
  syncHostName: () => Promise<NetworkSnapshot | { success: false; error: NetworkErrorCode }>,
): Promise<HostApiRouteResult> {
  const read = url.pathname === '/api/access' && req.method === 'GET';
  const command = url.pathname === '/api/access/command' && req.method === 'POST';
  if (!read && !command) return undefined;
  if (req.signal.aborted) return null;
  if (url.search) return jsonResult(400, INVALID);
  let body: AccessCommand | undefined;
  if (command) {
    try {
      const bytes = await req.readBytes(64 * 1024, true);
      const serialized = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      // The Main owner validates the complete command before queueing it.
      body = JSON.parse(serialized) as AccessCommand;
    } catch { return req.signal.aborted ? null : jsonResult(400, INVALID); }
  }
  try {
    if (command && body?.change?.kind === 'resource.capability' && !await resolveCapability(body.change.sourceId)) return jsonResult(400, INVALID);
    const response = read ? await access.read(req.signal) : await access.command(body!, req.signal);
    if (response.status === 200 && body?.change.kind === 'host.rename') {
      const network = await syncHostName();
      if ('success' in network && network.success === false) return req.signal.aborted ? null : jsonResult(503, network);
    }
    return req.signal.aborted ? null : jsonResult(response.status, response.body);
  } catch {
    return req.signal.aborted ? null : jsonResult(503, command ? UNKNOWN : UNAVAILABLE);
  }
}
