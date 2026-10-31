import type { RuntimeHostTransportContext } from '../context';
import { jsonResult, type HostApiRequest, type HostApiRouteResult } from '../execution';

const UNAVAILABLE = {
  success: false,
  error: 'Session history is unavailable',
} as const;

type SessionHistoryRouteDeps = RuntimeHostTransportContext<'sessionHistoryTransport'>;

export async function handleSessionHistoryRoutes(
  req: HostApiRequest,
  url: URL,
  deps: SessionHistoryRouteDeps,
): Promise<HostApiRouteResult> {
  if (req.method !== 'POST') return undefined;

  if (url.pathname !== '/api/sessions/history') return undefined;
  const transport = deps.runtimeHostTransports.sessionHistoryTransport;

  let request: unknown;
  try {
    request = await req.readJson<unknown>();
  } catch {
    request = undefined;
  }

  try {
    const response = await transport.read(request);
    return jsonResult(response.status, response.body);
  } catch {
    return jsonResult(503, UNAVAILABLE);
  }
}
