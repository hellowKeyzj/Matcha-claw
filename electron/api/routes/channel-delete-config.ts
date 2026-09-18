import type { IncomingMessage, ServerResponse } from 'http';
import type {
  ChannelDeleteConfigRequest,
  ChannelDeleteConfigTransport,
} from '../../main/runtime-host-delivery/transport/channels/delete-config';
import { parseJsonBody, sendJson } from '../route-utils';
import { beginChannelTrace, channelTraceError, readChannelTrace } from '../../main/runtime-host-delivery/transport/channels/trace';

const INVALID = { outcome: 'rejected' } as const;
const UNKNOWN = { outcome: 'unknown' } as const;

export async function handleChannelDeleteConfigRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  transport: ChannelDeleteConfigTransport,
): Promise<boolean> {
  if (url.pathname !== '/api/channels/delete-config' || req.method !== 'POST') return false;

  const traceId = readChannelTrace(req.headers);
  let body: unknown;
  try {
    body = await parseJsonBody(req);
  } catch {
    beginChannelTrace('route.invalid', traceId)(400, { outcome: 'rejected' });
    sendJson(res, 400, INVALID);
    return true;
  }
  if (!isRequest(body)) {
    beginChannelTrace('route.invalid', traceId)(400, { outcome: 'rejected' });
    sendJson(res, 400, INVALID);
    return true;
  }

  const finish = beginChannelTrace('route.delete', traceId);
  try {
    const response = await transport.deleteConfig(body, traceId);
    finish(response.status, response.body);
    sendJson(res, response.status, response.body);
  } catch (error) {
    finish(503, UNKNOWN, channelTraceError(error));
    sendJson(res, 503, UNKNOWN);
  }
  return true;
}

function isRequest(value: unknown): value is ChannelDeleteConfigRequest {
  return isRecord(value)
    && Object.keys(value).every((key) => key === 'channel' || key === 'accountId')
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
