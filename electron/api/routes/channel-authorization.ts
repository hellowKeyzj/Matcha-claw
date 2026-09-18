import type { IncomingMessage, ServerResponse } from 'http';
import type {
  ChannelAuthorizationRequest,
  ChannelAuthorizationTransport,
} from '../../main/runtime-host-delivery/transport/channels/authorization';
import { parseJsonBody, sendJson } from '../route-utils';
import { beginChannelTrace, channelTraceError, readChannelTrace } from '../../main/runtime-host-delivery/transport/channels/trace';

const INVALID = { outcome: 'rejected' } as const;
const UNKNOWN = { outcome: 'unknown', channel: 'qqbot' } as const;

export async function handleChannelAuthorizationRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  transport: ChannelAuthorizationTransport,
): Promise<boolean> {
  if (url.pathname !== '/api/channels/authorization' || req.method !== 'POST') return false;

  const traceId = readChannelTrace(req.headers);
  let body: unknown;
  try {
    body = await parseJsonBody(req);
  } catch {
    beginChannelTrace('route.authorization.invalid', traceId)(400, INVALID);
    sendJson(res, 400, INVALID);
    return true;
  }

  if (!isRequest(body)) {
    beginChannelTrace('route.authorization.invalid', traceId)(400, INVALID);
    sendJson(res, 400, INVALID);
    return true;
  }

  const finish = beginChannelTrace(`route.authorization.${body.action}`, traceId);
  try {
    const response = await transport.authorize(body, traceId);
    finish(response.status, response.body);
    sendJson(res, response.status, response.body);
  } catch (error) {
    finish(503, UNKNOWN, channelTraceError(error));
    sendJson(res, 503, { ...UNKNOWN, channel: body.channel });
  }
  return true;
}

function isRequest(value: unknown): value is ChannelAuthorizationRequest {
  if (!isRecord(value)) return false;
  if (value.action !== 'start' && value.action !== 'wait' && value.action !== 'cancel') return false;
  if (value.channel !== 'qqbot' && value.channel !== 'dingtalk' && value.channel !== 'feishu') return false;
  if (value.accountId !== undefined && !isIdentity(value.accountId)) return false;
  if (value.agentId !== undefined && !isIdentity(value.agentId)) return false;
  if (value.sessionKey !== undefined && !isIdentity(value.sessionKey)) return false;
  if (value.timeoutMs !== undefined && !isTimeout(value.timeoutMs)) return false;
  if (value.config !== undefined && !isRecord(value.config)) return false;

  const keys = Object.keys(value);
  if (value.action === 'start') {
    return keys.every((key) => ['action', 'channel', 'accountId', 'agentId', 'config', 'timeoutMs'].includes(key));
  }
  if (value.sessionKey === undefined) return false;
  return keys.every((key) => ['action', 'channel', 'accountId', 'sessionKey', 'timeoutMs'].includes(key));
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
