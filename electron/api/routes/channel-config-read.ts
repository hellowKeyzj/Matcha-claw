import type { IncomingMessage, ServerResponse } from 'http';
import type { ChannelConfigReadTransport } from '../../main/runtime-host-delivery/transport/channels/config-read';
import { parseJsonBody, sendJson } from '../route-utils';
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
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  transport: ChannelConfigReadTransport,
): Promise<boolean> {
  if (url.pathname !== '/api/channels/config/read' || req.method !== 'POST') return false;

  const traceId = readChannelTrace(req.headers);
  let body: unknown;
  try {
    body = await parseJsonBody(req);
  } catch {
    beginChannelTrace('route.config_read.invalid', traceId)(400, INVALID);
    sendJson(res, 400, INVALID);
    return true;
  }
  if (!isRequest(body)) {
    beginChannelTrace('route.config_read.invalid', traceId)(400, INVALID);
    sendJson(res, 400, INVALID);
    return true;
  }

  const finish = beginChannelTrace('route.config_read', traceId);
  try {
    const projection = await transport.read(body, traceId);
    if (projection) {
      const response = { success: true, values: projection.values, agentId: projection.agentId };
      finish(200, response);
      sendJson(res, 200, response);
    } else {
      finish(503, UNAVAILABLE);
      sendJson(res, 503, UNAVAILABLE);
    }
  } catch (error) {
    finish(503, UNAVAILABLE, channelTraceError(error));
    sendJson(res, 503, UNAVAILABLE);
  }
  return true;
}

function isRequest(value: unknown): value is { channel: string; accountId?: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length < 1 || keys.length > 2 || !keys.every((key) => key === 'channel' || key === 'accountId')) {
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
