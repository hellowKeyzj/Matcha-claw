import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../../api/route-utils';
import { WORLD_ROUTES, worldDeliveryFailure, type WorldRoute, type WorldTransport } from './transport';

export async function handleWorldRoutes(
  req: IncomingMessage, res: ServerResponse, url: URL, transport: WorldTransport,
): Promise<boolean> {
  const route = (Object.keys(WORLD_ROUTES) as WorldRoute[]).find((key) => WORLD_ROUTES[key] === url.pathname);
  if (!route || req.method !== 'POST') return false;
  const controller = new AbortController();
  const onClose = () => { if (!res.writableEnded) controller.abort(); };
  res.once('close', onClose);
  try {
    if (url.search) {
      sendJson(res, 400, worldDeliveryFailure('world.delivery_invalid', false));
      return true;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let body: unknown;
    let serialized: string;
    try {
      for await (const chunk of req) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > 1_048_576) throw new Error('World request exceeds the byte limit');
        chunks.push(bytes);
      }
      serialized = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
      body = JSON.parse(serialized);
    } catch {
      if (!controller.signal.aborted) sendJson(res, 400, worldDeliveryFailure('world.delivery_invalid', false));
      return true;
    }
    const delivery = await transport.request(route, body, controller.signal, serialized);
    if (controller.signal.aborted) return true;
    if (delivery.outcome === 'response') sendJson(res, delivery.response.status, delivery.response.body);
    else {
      res.setHeader('X-MatchaClaw-World-Delivery', delivery.outcome);
      sendJson(res, 503, worldDeliveryFailure(
        delivery.outcome === 'unknown' ? 'world.delivery_unknown' : 'world.delivery_not_attempted', delivery.outcome === 'unknown',
      ));
    }
  } finally { res.off('close', onClose); }
  return true;
}
