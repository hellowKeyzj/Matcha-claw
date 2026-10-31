import { jsonResult, type HostApiRequest, type HostApiRouteResult } from '../execution';
import type {
  ChannelAuthorizationRequest,
  ChannelAuthorizationActions,
} from '../../main/channels/authorization';
import { isProductRuntimeScope } from '../../main/runtime-host-delivery/transport/runtime-scope';
import { beginChannelTrace, channelTraceError, readChannelTrace } from '../../main/runtime-host-delivery/transport/channels/trace';

const INVALID = { outcome: 'rejected' } as const;
const UNKNOWN = { outcome: 'unknown', channel: 'qqbot' } as const;

export async function handleChannelAuthorizationRoutes(
  req: HostApiRequest,
  url: URL,
  authorization: ChannelAuthorizationActions,
): Promise<HostApiRouteResult> {
  if (url.pathname !== '/api/channels/authorization' || req.method !== 'POST') return undefined;

  const traceId = readChannelTrace(req.headers);
  let body: unknown;
  try {
    body = await req.readJson();
  } catch {
    beginChannelTrace('route.authorization.invalid', traceId)?.(400, INVALID);
    return jsonResult(400, INVALID);
  }

  if (!isRequest(body)) {
    beginChannelTrace('route.authorization.invalid', traceId)?.(400, INVALID);
    return jsonResult(400, INVALID);
  }

  const finish = beginChannelTrace(() => `route.authorization.${body.action}`, traceId);
  try {
    const response = await authorization.authorize(body, traceId);
    finish?.(response.status, response.body);
    return jsonResult(response.status, response.body);
  } catch (error) {
    finish?.(503, UNKNOWN, channelTraceError(error));
    return jsonResult(503, { ...UNKNOWN, channel: body.channel });
  }
}

function isRequest(value: unknown): value is ChannelAuthorizationRequest {
  if (!isRecord(value)) return false;
  if (Object.hasOwn(value, 'scope')
    && (!isProductRuntimeScope(value.scope) || value.scope.endpoint.runtimeAdapterId !== 'openclaw')) return false;
  if (value.action !== 'start' && value.action !== 'wait' && value.action !== 'cancel') return false;
  if (value.channel !== 'qqbot' && value.channel !== 'dingtalk' && value.channel !== 'feishu') return false;
  if (value.accountId !== undefined && !isIdentity(value.accountId)) return false;
  if (value.agentId !== undefined && !isIdentity(value.agentId)) return false;
  if (value.sessionKey !== undefined && !isIdentity(value.sessionKey)) return false;
  if (value.timeoutMs !== undefined && !isTimeout(value.timeoutMs)) return false;
  if (value.config !== undefined && !isRecord(value.config)) return false;

  const keys = Object.keys(value);
  if (value.action === 'start') {
    return keys.every((key) => ['action', 'channel', 'accountId', 'agentId', 'config', 'timeoutMs', 'scope'].includes(key));
  }
  if (value.sessionKey === undefined) return false;
  return keys.every((key) => ['action', 'channel', 'accountId', 'sessionKey', 'timeoutMs', 'scope'].includes(key));
}

function isIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/\s/.test(value);
}

function isTimeout(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 300_000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
