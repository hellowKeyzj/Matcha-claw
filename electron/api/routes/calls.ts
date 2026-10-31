import type { CallLogTransport } from '../../main/runtime-host-delivery/transport/call-log';
import { jsonResult, type HostApiRequest, type HostApiRouteResult } from '../execution';

export async function handleCallRoutes(
  req: HostApiRequest,
  url: URL,
  transport: CallLogTransport,
): Promise<HostApiRouteResult> {
  if (req.method !== 'POST') return undefined;
  const operation = url.pathname === '/api/calls/list' ? 'list'
    : url.pathname === '/api/calls/get' ? 'get'
      : url.pathname === '/api/calls/history' ? 'history' : null;
  if (!operation) return undefined;
  let body: unknown;
  try {
    body = await req.readJson<unknown>();
  } catch {
    return jsonResult(400, { success: false, error: 'Call log input is invalid' });
  }
  try {
    const response = await transport[operation](body);
    return jsonResult(response.status, response.body);
  } catch {
    return jsonResult(503, { success: false, error: 'Call log is unavailable' });
  }
}
