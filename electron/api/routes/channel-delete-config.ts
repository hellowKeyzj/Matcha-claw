import { jsonResult, type HostApiRequest, type HostApiRouteResult } from '../execution';
import type {
  ChannelDeleteConfigRequest,
  ChannelDeleteConfigTransport,
} from '../../main/runtime-host-delivery/transport/channels/delete-config';
import { isProductRuntimeScope } from '../../main/runtime-host-delivery/transport/runtime-scope';
import { beginChannelTrace, channelTraceError, readChannelTrace } from '../../main/runtime-host-delivery/transport/channels/trace';

const INVALID = { outcome: 'rejected' } as const;
const UNKNOWN = { outcome: 'unknown' } as const;

export async function handleChannelDeleteConfigRoutes(
  req: HostApiRequest,
  url: URL,
  transport: ChannelDeleteConfigTransport,
): Promise<HostApiRouteResult> {
  if (url.pathname !== '/api/channels/delete-config' || req.method !== 'POST') return undefined;

  const traceId = readChannelTrace(req.headers);
  let body: unknown;
  try {
    body = await req.readJson();
  } catch {
    beginChannelTrace('route.invalid', traceId)?.(400, { outcome: 'rejected' });
    return jsonResult(400, INVALID);
  }
  if (!isRequest(body)) {
    beginChannelTrace('route.invalid', traceId)?.(400, { outcome: 'rejected' });
    return jsonResult(400, INVALID);
  }

  const finish = beginChannelTrace('route.delete', traceId);
  try {
    const response = await transport.deleteConfig(body, traceId);
    finish?.(response.status, response.body);
    return jsonResult(response.status, response.body);
  } catch (error) {
    finish?.(503, UNKNOWN, channelTraceError(error));
    return jsonResult(503, UNKNOWN);
  }
}

function isRequest(value: unknown): value is ChannelDeleteConfigRequest {
  return isRecord(value)
    && Object.keys(value).every((key) => ['channel', 'accountId', 'scope'].includes(key))
    && (!Object.hasOwn(value, 'scope') || isProductRuntimeScope(value.scope))
    && isIdentity(value.channel)
    && (value.accountId === undefined || isIdentity(value.accountId));
}

function isIdentity(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 128
    && !value.split('').some((character) => /\s/.test(character) || character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
