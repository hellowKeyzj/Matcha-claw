import type { IncomingMessage, ServerResponse } from 'http';
import {
  isChannelSnapshot,
  type ChannelStatusTransport,
} from '../../main/runtime-host-delivery/transport/channels/status';
import { parseJsonBody, sendJson } from '../route-utils';

const INVALID = {
  success: false,
  error: 'Channel status request is invalid',
} as const;
const UNAVAILABLE = {
  success: false,
  error: 'Channel status is unavailable',
} as const;

export async function handleChannelStatusRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  transport: ChannelStatusTransport,
): Promise<boolean> {
  if (url.pathname === '/api/channels/snapshot' && req.method === 'GET') {
    try {
      const response = await transport.readSnapshot();
      if (response.status === 200 && isChannelSnapshot(response.body)) {
        sendJson(res, 200, {
          success: true,
          snapshot: response.body,
          ready: response.body.ready ?? true,
          refreshing: response.body.refreshing ?? false,
          updatedAt: response.body.ts,
          error: response.body.error ?? null,
        });
      } else {
        sendJson(res, 503, UNAVAILABLE);
      }
    } catch {
      sendJson(res, 503, UNAVAILABLE);
    }
    return true;
  }

  if (url.pathname !== '/api/channels/status' || req.method !== 'POST') return false;

  let body: unknown;
  try {
    body = await parseJsonBody(req);
  } catch {
    sendJson(res, 400, INVALID);
    return true;
  }
  if (!isEmptyObject(body)) {
    sendJson(res, 400, INVALID);
    return true;
  }

  try {
    const response = await transport.read();
    if (response.status === 200 && isRecord(response.body) && Array.isArray(response.body.accounts)) {
      sendJson(res, 200, response.body);
    } else {
      sendJson(res, 503, UNAVAILABLE);
    }
  } catch {
    sendJson(res, 503, UNAVAILABLE);
  }
  return true;
}

function isEmptyObject(value: unknown): value is Record<string, never> {
  return isRecord(value) && Object.keys(value).length === 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
