import type { IncomingMessage, ServerResponse } from 'http';
import type {
  ChannelDeleteConfigRequest,
  ChannelDeleteConfigTransport,
} from '../../main/runtime-host-delivery/transport/channels/delete-config';
import { parseJsonBody, sendJson } from '../route-utils';

const INVALID = { outcome: 'rejected' } as const;
const UNKNOWN = { outcome: 'unknown' } as const;

export async function handleChannelDeleteConfigRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  transport: ChannelDeleteConfigTransport,
): Promise<boolean> {
  if (url.pathname !== '/api/channels/delete-config' || req.method !== 'POST') return false;

  let body: unknown;
  try {
    body = await parseJsonBody(req);
  } catch {
    sendJson(res, 400, INVALID);
    return true;
  }
  if (!isRequest(body)) {
    sendJson(res, 400, INVALID);
    return true;
  }

  try {
    const response = await transport.deleteConfig(body);
    sendJson(res, response.status, response.body);
  } catch {
    sendJson(res, 503, UNKNOWN);
  }
  return true;
}

function isRequest(value: unknown): value is ChannelDeleteConfigRequest {
  return isRecord(value)
    && Object.keys(value).length === 2
    && isIdentity(value.channel)
    && isIdentity(value.accountId);
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
