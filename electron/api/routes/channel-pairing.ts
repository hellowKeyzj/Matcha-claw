import { jsonResult, type HostApiRequest, type HostApiRouteResult } from '../execution';
import type { ChannelPairingTransport } from '../../main/runtime-host-delivery/transport/channels/pairing';
import { isProductRuntimeScope, readRuntimeScopeQuery, type ProductRuntimeScope } from '../../main/runtime-host-delivery/transport/runtime-scope';

const INVALID = {
  success: false,
  error: 'Channel pairing request is invalid',
} as const;
const UNAVAILABLE = {
  success: false,
  error: 'Channel pairing is unavailable',
} as const;

export async function handleChannelPairingRoutes(
  req: HostApiRequest,
  url: URL,
  transport: ChannelPairingTransport,
): Promise<HostApiRouteResult> {
  const pairingChannel = readPairingChannel(url.pathname);
  if (pairingChannel && req.method === 'GET') {
    try {
      const response = await transport.list(pairingChannel, url.searchParams.get('accountId') ?? undefined, readRuntimeScopeQuery(url.searchParams));
      return jsonResult(response.status, response.body);
    } catch {
      return jsonResult(503, UNAVAILABLE);
    }
  }

  if (url.pathname !== '/api/channels/pairing' || req.method !== 'POST') return undefined;

  let body: unknown;
  try {
    body = await req.readJson();
  } catch {
    return jsonResult(400, INVALID);
  }

  try {
    if (isListRequest(body)) {
      const response = await transport.list(body.channel, body.accountId, body.scope);
      return jsonResult(response.status, response.body);
    }
    if (isApprovalRequest(body)) {
      const response = await transport.approve({
        channel: body.channel,
        ...(body.accountId !== undefined ? { accountId: body.accountId } : {}),
        code: body.code,
        ...(body.scope === undefined ? {} : { scope: body.scope }),
      });
      return jsonResult(response.status, response.body);
    }
  } catch {
    return jsonResult(503, UNAVAILABLE);
  }

  return jsonResult(400, INVALID);
}

function readPairingChannel(pathname: string): string | null {
  const prefix = '/api/channels/pairing/';
  if (!pathname.startsWith(prefix)) return null;
  const channel = decodeURIComponent(pathname.slice(prefix.length));
  return isIdentity(channel) ? channel : null;
}

function isListRequest(value: unknown): value is Readonly<{ channel: string; accountId?: string; scope?: ProductRuntimeScope }> {
  return isRecord(value)
    && Object.keys(value).every((key) => ['channel', 'accountId', 'scope'].includes(key))
    && (!Object.hasOwn(value, 'scope') || isProductRuntimeScope(value.scope))
    && isIdentity(value.channel)
    && (value.accountId === undefined || isIdentity(value.accountId));
}

function isApprovalRequest(value: unknown): value is Readonly<{
  action: 'approve';
  channel: string;
  accountId?: string;
  code: string;
  scope?: ProductRuntimeScope;
}> {
  return isRecord(value)
    && Object.keys(value).every((key) => ['action', 'channel', 'accountId', 'code', 'scope'].includes(key))
    && (!Object.hasOwn(value, 'scope') || isProductRuntimeScope(value.scope))
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
