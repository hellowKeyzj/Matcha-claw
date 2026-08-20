import type { IncomingMessage, ServerResponse } from 'http';
import type { ChannelCatalogTransport } from '../../main/runtime-host-delivery/transport/channels/catalog';
import { parseJsonBody, sendJson } from '../route-utils';

const INVALID = {
  success: false,
  error: 'Channel catalog request is invalid',
} as const;
const UNAVAILABLE = {
  success: false,
  error: 'Channel catalog is unavailable',
} as const;

export async function handleChannelCatalogRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  transport: ChannelCatalogTransport,
): Promise<boolean> {
  if (url.pathname !== '/api/channels/catalog' || req.method !== 'POST') return false;

  let body: unknown;
  try {
    body = await parseJsonBody(req);
  } catch {
    sendJson(res, 400, INVALID);
    return true;
  }
  if (!isEmptyObject(body)) {
    sendJson(res, 400, INVALID);
    return true;
  }

  try {
    const response = await transport.read();
    sendJson(res, response.status === 200 ? 200 : 503, response.status === 200 ? response.body : UNAVAILABLE);
  } catch {
    sendJson(res, 503, UNAVAILABLE);
  }
  return true;
}

function isEmptyObject(value: unknown): value is Record<string, never> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
}
