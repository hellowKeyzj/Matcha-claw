import type { IncomingMessage, ServerResponse } from 'http';
import type { ChannelControlTransport } from '../../main/runtime-host-delivery/transport/channels/control';
import { parseJsonBody, sendJson } from '../route-utils';

const INVALID = {
  success: false,
  error: 'Channel control request is invalid',
} as const;
const UNAVAILABLE = {
  success: false,
  error: 'Channel control is unavailable',
} as const;

type RequestBody = Readonly<{
  action: 'connect' | 'disconnect';
  channel: string;
  accountId: string;
}>;

export async function handleChannelControlRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  transport: ChannelControlTransport,
): Promise<boolean> {
  if (url.pathname !== '/api/channels/control' || req.method !== 'POST') return false;

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
    const response = await transport.control(body);
    sendJson(res, response.status,
      (body.action === 'connect' && response.status === 200)
        || (body.action === 'disconnect' && response.status === 202) ? response.body : UNAVAILABLE);
  } catch {
    sendJson(res, 503, UNAVAILABLE);
  }
  return true;
}

function isRequest(value: unknown): value is RequestBody {
  if (!isRecord(value)) return false;
  return Object.keys(value).length === 3
    && (value.action === 'connect' || value.action === 'disconnect')
    && isIdentity(value.channel)
    && isIdentity(value.accountId);
}

function isIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/\s/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
