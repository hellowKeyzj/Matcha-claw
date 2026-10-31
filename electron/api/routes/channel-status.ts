import { jsonResult, type HostApiRequest, type HostApiRouteResult } from '../execution';
import {
  isChannelSnapshot,
  type ChannelStatusTransport,
} from '../../main/runtime-host-delivery/transport/channels/status';
import { isProductRuntimeScope, readRuntimeScopeQuery } from '../../main/runtime-host-delivery/transport/runtime-scope';

const INVALID = {
  success: false,
  error: 'Channel status request is invalid',
} as const;
const UNAVAILABLE = {
  success: false,
  error: 'Channel status is unavailable',
} as const;

export async function handleChannelStatusRoutes(
  req: HostApiRequest,
  url: URL,
  transport: ChannelStatusTransport,
): Promise<HostApiRouteResult> {
  if (url.pathname === '/api/channels/snapshot' && req.method === 'GET') {
    try {
      const response = await transport.readSnapshot(readRuntimeScopeQuery(url.searchParams));
      if (response.status === 200 && isChannelSnapshot(response.body)) {
        return jsonResult(200, {
          success: true,
          snapshot: response.body,
          ready: response.body.ready ?? true,
          refreshing: response.body.refreshing ?? false,
          updatedAt: response.body.ts,
          error: response.body.error ?? null,
        });
      } else {
        return jsonResult(503, UNAVAILABLE);
      }
    } catch {
      return jsonResult(503, UNAVAILABLE);
    }
  }

  if (url.pathname !== '/api/channels/status' || req.method !== 'POST') return undefined;

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
    if (response.status === 200 && isRecord(response.body) && 'accounts' in response.body && Array.isArray(response.body.accounts)) {
      return jsonResult(200, response.body);
    } else {
      return jsonResult(503, UNAVAILABLE);
    }
  } catch {
    return jsonResult(503, UNAVAILABLE);
  }
}

function isEmptyObject(value: unknown): value is Record<string, never> {
  return isRecord(value) && Object.keys(value).length === 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
