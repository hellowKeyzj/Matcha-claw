import { jsonResult, type HostApiRequest, type HostApiRouteResult } from '../execution';
import { WORLD_ROUTES, worldDeliveryFailure, type WorldRoute, type WorldTransport } from '../../main/world/transport';

export async function handleWorldRoutes(
  req: HostApiRequest, url: URL, transport: WorldTransport,
): Promise<HostApiRouteResult> {
  const route = (Object.keys(WORLD_ROUTES) as WorldRoute[]).find((key) => WORLD_ROUTES[key] === url.pathname);
  if (!route || req.method !== 'POST') return undefined;
  if (url.search) {
    return jsonResult(400, worldDeliveryFailure('world.delivery_invalid', false));
  }
  let body: unknown;
  let serialized: string;
  try {
    serialized = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await req.readBytes(1_048_576));
    body = JSON.parse(serialized);
  } catch {
    return req.signal.aborted ? null : jsonResult(400, worldDeliveryFailure('world.delivery_invalid', false));
  }
  const delivery = await transport.request(route, body, req.signal, serialized);
  if (req.signal.aborted) return null;
  if (delivery.outcome === 'response') return jsonResult(delivery.response.status, delivery.response.body);
  return jsonResult(503, worldDeliveryFailure(
    delivery.outcome === 'unknown' ? 'world.delivery_unknown' : 'world.delivery_not_attempted', delivery.outcome === 'unknown',
  ), { 'X-MatchaClaw-World-Delivery': delivery.outcome });
}
