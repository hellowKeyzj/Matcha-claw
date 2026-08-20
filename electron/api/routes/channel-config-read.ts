import type { IncomingMessage, ServerResponse } from 'http';
import type { ChannelConfigReadTransport } from '../../main/runtime-host-delivery/transport/channels/config-read';
import { parseJsonBody, sendJson } from '../route-utils';

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
    const projection = await transport.read(body);
    if (projection) {
      sendJson(res, 200, { success: true, values: projection.values });
    } else {
      sendJson(res, 503, UNAVAILABLE);
    }
  } catch {
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
