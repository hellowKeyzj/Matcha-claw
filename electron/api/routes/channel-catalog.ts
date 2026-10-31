import { jsonResult, type HostApiRequest, type HostApiRouteResult } from '../execution';
import type { ChannelCatalogTransport } from '../../main/runtime-host-delivery/transport/channels/catalog';
import { isProductRuntimeScope } from '../../main/runtime-host-delivery/transport/runtime-scope';

const INVALID = {
  success: false,
  error: 'Channel catalog request is invalid',
} as const;
const UNAVAILABLE = {
  success: false,
  error: 'Channel catalog is unavailable',
} as const;

export async function handleChannelCatalogRoutes(
  req: HostApiRequest,
  url: URL,
  transport: ChannelCatalogTransport,
): Promise<HostApiRouteResult> {
  if (url.pathname !== '/api/channels/catalog' || req.method !== 'POST') return undefined;

  let body: unknown;
  try {
    body = await req.readJson();
  } catch {
    return jsonResult(400, INVALID);
  }
  if (!isEmptyObject(body)
    && !(isRecord(body) && Object.keys(body).length === 1 && isProductRuntimeScope(body.scope))) {
    return jsonResult(400, INVALID);
  }

  try {
    const response = await transport.read(isRecord(body) ? body.scope : undefined);
    return jsonResult(response.status === 200 ? 200 : 503, response.status === 200 ? response.body : UNAVAILABLE);
  } catch {
    return jsonResult(503, UNAVAILABLE);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isEmptyObject(value: unknown): value is Record<string, never> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
}
