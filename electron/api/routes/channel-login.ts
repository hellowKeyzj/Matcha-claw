import type { IncomingMessage, ServerResponse } from 'http';
import type {
  ChannelLoginRequest,
  ChannelLoginTransport,
} from '../../main/runtime-host-delivery/transport/channels/login';
import { parseJsonBody, sendJson } from '../route-utils';

const INVALID = { outcome: 'rejected' } as const;
const UNKNOWN = { outcome: 'unknown' } as const;
const MAX_CONFIG_BYTES = 16_384;
const MAX_CONFIG_DEPTH = 8;
const MAX_CONFIG_PROPERTIES = 128;

export async function handleChannelLoginRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  transport: ChannelLoginTransport,
): Promise<boolean> {
  if (url.pathname !== '/api/channels/login' || req.method !== 'POST') return false;

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
    const response = await transport.login(body);
    sendJson(res, response.status, response.body);
  } catch {
    sendJson(res, 503, UNKNOWN);
  }
  return true;
}

function isRequest(value: unknown): value is ChannelLoginRequest {
  if (!isRecord(value) || !isIdentity(value.channel)) return false;
  if (value.action !== 'start' && value.action !== 'wait' && value.action !== 'cancel' && value.action !== 'logout') return false;
  if (value.accountId !== undefined && !isIdentity(value.accountId)) return false;

  const keys = Object.keys(value);
  if (value.action === 'cancel' || value.action === 'logout') {
    return keys.every((key) => key === 'action' || key === 'channel' || key === 'accountId') && keys.length <= 3;
  }
  if (value.action === 'start') {
    return keys.every((key) => ['action', 'channel', 'accountId', 'config', 'force', 'timeoutMs'].includes(key))
      && (value.config === undefined || isConfig(value.config))
      && (value.force === undefined || typeof value.force === 'boolean')
      && (value.timeoutMs === undefined || isTimeout(value.timeoutMs));
  }
  return keys.every((key) => ['action', 'channel', 'accountId', 'sessionKey', 'currentQrDataUrl', 'timeoutMs'].includes(key))
    && (value.sessionKey === undefined || isIdentity(value.sessionKey))
    && (value.currentQrDataUrl === undefined || isQrDataUrl(value.currentQrDataUrl))
    && (value.timeoutMs === undefined || isTimeout(value.timeoutMs));
}

function isIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/\s/.test(value);
}

function isConfig(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  const state = { properties: 0, seen: new WeakSet<object>() };
  try {
    if (!isConfigValue(value, 0, state)) return false;
    const serialized = JSON.stringify(value);
    return serialized !== undefined && Buffer.byteLength(serialized, 'utf8') <= MAX_CONFIG_BYTES;
  } catch {
    return false;
  }
}

function isConfigValue(
  value: unknown,
  depth: number,
  state: { properties: number; seen: WeakSet<object> },
): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || depth > MAX_CONFIG_DEPTH || state.seen.has(value)) return false;
  state.seen.add(value);
  state.properties += Array.isArray(value) ? value.length : Object.keys(value).length;
  if (state.properties > MAX_CONFIG_PROPERTIES) return false;
  const valid = Array.isArray(value)
    ? value.every((child) => isConfigValue(child, depth + 1, state))
    : isPlainObject(value) && Object.values(value).every((child) => isConfigValue(child, depth + 1, state));
  state.seen.delete(value);
  return valid;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function isTimeout(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 300_000;
}

function isQrDataUrl(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('data:image/png;base64,') && value.length <= 16_384;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
