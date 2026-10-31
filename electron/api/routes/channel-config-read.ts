import { jsonResult, type HostApiRequest, type HostApiRouteResult } from '../execution';
import type { ChannelConfigReadTransport } from '../../main/runtime-host-delivery/transport/channels/config-read';
import { isProductRuntimeScope, type ProductRuntimeScope } from '../../main/runtime-host-delivery/transport/runtime-scope';
import { beginChannelTrace, channelTraceError, readChannelTrace } from '../../main/runtime-host-delivery/transport/channels/trace';

const INVALID = {
  success: false,
  error: 'Channel configuration request is invalid',
} as const;
const UNAVAILABLE = {
  success: false,
  error: 'Channel configuration is unavailable',
} as const;

export async function handleChannelConfigReadRoutes(
  req: HostApiRequest,
  url: URL,
  transport: ChannelConfigReadTransport,
): Promise<HostApiRouteResult> {
  if (url.pathname !== '/api/channels/config/read' || req.method !== 'POST') return undefined;

  const traceId = readChannelTrace(req.headers);
  let body: unknown;
  try {
    body = await req.readJson();
  } catch {
    beginChannelTrace('route.config_read.invalid', traceId)?.(400, INVALID);
    return jsonResult(400, INVALID);
  }
  if (!isRequest(body)) {
    beginChannelTrace('route.config_read.invalid', traceId)?.(400, INVALID);
    return jsonResult(400, INVALID);
  }

  const finish = beginChannelTrace('route.config_read', traceId);
  try {
    const projection = await transport.read(body, traceId);
    if (projection) {
      const response = { success: true, values: projection.values, agentId: projection.agentId };
      finish?.(200, response);
      return jsonResult(200, response);
    } else {
      finish?.(503, UNAVAILABLE);
      return jsonResult(503, UNAVAILABLE);
    }
  } catch (error) {
    finish?.(503, UNAVAILABLE, channelTraceError(error));
    return jsonResult(503, UNAVAILABLE);
  }
}

function isRequest(value: unknown): value is { channel: string; accountId?: string; scope?: ProductRuntimeScope } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length < 1 || keys.length > 3 || !keys.every((key) => ['channel', 'accountId', 'scope'].includes(key))
    || (Object.hasOwn(record, 'scope') && !isProductRuntimeScope(record.scope))) {
    return false;
  }
  return isIdentity(record.channel)
    && (record.accountId === undefined || isIdentity(record.accountId));
}

function isIdentity(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 128
    && !value.includes('/')
    && !value.includes('\\')
    && [...value].every((character) => {
      const code = character.charCodeAt(0);
      return character.trim() === character && code >= 32 && code !== 127;
    });
}
