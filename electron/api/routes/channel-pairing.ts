import type { IncomingMessage, ServerResponse } from 'http';
import type { ChannelPairingTransport } from '../../main/runtime-host-delivery/transport/channels/pairing';
import { parseJsonBody, sendJson } from '../route-utils';

const INVALID = {
  success: false,
  error: 'Channel pairing request is invalid',
} as const;
const UNAVAILABLE = {
  success: false,
  error: 'Channel pairing is unavailable',
} as const;

export async function handleChannelPairingRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  transport: ChannelPairingTransport,
): Promise<boolean> {
  const pairingChannel = readPairingChannel(url.pathname);
  if (pairingChannel && req.method === 'GET') {
    try {
      const response = await transport.list(pairingChannel, url.searchParams.get('accountId') ?? undefined);
      sendJson(res, response.status, response.body);
    } catch {
      sendJson(res, 503, UNAVAILABLE);
    }
    return true;
  }

  if (url.pathname !== '/api/channels/pairing' || req.method !== 'POST') return false;

  let body: unknown;
  try {
    body = await parseJsonBody(req);
  } catch {
    sendJson(res, 400, INVALID);
    return true;
  }

  try {
    if (isListRequest(body)) {
      const response = await transport.list(body.channel, body.accountId);
      sendJson(res, response.status, response.body);
      return true;
    }
    if (isApprovalRequest(body)) {
      const response = await transport.approve({
        channel: body.channel,
        ...(body.accountId !== undefined ? { accountId: body.accountId } : {}),
        code: body.code,
      });
      sendJson(res, response.status, response.body);
      return true;
    }
  } catch {
    sendJson(res, 503, UNAVAILABLE);
    return true;
  }

  sendJson(res, 400, INVALID);
  return true;
}

function readPairingChannel(pathname: string): string | null {
  const prefix = '/api/channels/pairing/';
  if (!pathname.startsWith(prefix)) return null;
  const channel = decodeURIComponent(pathname.slice(prefix.length));
  return isIdentity(channel) ? channel : null;
}

function isListRequest(value: unknown): value is Readonly<{ channel: string; accountId?: string }> {
  return isRecord(value)
    && (hasExactKeys(value, ['channel']) || hasExactKeys(value, ['channel', 'accountId']))
    && isIdentity(value.channel)
    && (value.accountId === undefined || isIdentity(value.accountId));
}

function isApprovalRequest(value: unknown): value is Readonly<{
  action: 'approve';
  channel: string;
  accountId?: string;
  code: string;
}> {
  return isRecord(value)
    && (hasExactKeys(value, ['action', 'channel', 'code'])
      || hasExactKeys(value, ['action', 'channel', 'accountId', 'code']))
    && value.action === 'approve'
    && isIdentity(value.channel)
    && isApprovalCode(value.code)
    && (value.accountId === undefined || isIdentity(value.accountId));
}

function isIdentity(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 128
    && [...value].every((character) => {
      const code = character.charCodeAt(0);
      return !/\s/.test(character) && code >= 32 && code !== 127;
    });
}

function isApprovalCode(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9]{1,128}$/.test(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
