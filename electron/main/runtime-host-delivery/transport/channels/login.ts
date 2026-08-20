import type { RuntimeHostDeliveryIssuer } from '../../bootstrap';

const DECISION_TTL_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_CONFIG_BYTES = 16_384;
const MAX_CONFIG_DEPTH = 8;
const MAX_CONFIG_PROPERTIES = 128;
const UNKNOWN = { outcome: 'unknown' } as const;
type RejectedResponse = Readonly<{ outcome: 'rejected' }>;

export type ChannelLoginAction = 'start' | 'wait' | 'cancel' | 'logout';

export type ChannelLoginRequest = Readonly<{
  action: ChannelLoginAction;
  channel: string;
  accountId?: string;
  sessionKey?: string;
  config?: Record<string, unknown>;
  force?: boolean;
  timeoutMs?: number;
  currentQrDataUrl?: string;
}>;

type LoginProgress = Readonly<{
  outcome: 'progress' | 'connected' | 'target_rejected' | 'unknown';
  channel: string;
  accountId?: string;
  qrDataUrl?: string;
  sessionKey?: string;
}>;

type LogoutOutcome = Readonly<{
  outcome: 'confirmed' | 'target_rejected' | 'unknown';
}>;

type CancelledOutcome = Readonly<{ outcome: 'cancelled' }>;

export type ChannelLoginTransportResponse = Readonly<{
  status: 200 | 400 | 503;
  body: LoginProgress | LogoutOutcome | CancelledOutcome | RejectedResponse | typeof UNKNOWN;
}>;

export interface ChannelLoginTransport {
  login(input: ChannelLoginRequest): Promise<ChannelLoginTransportResponse>;
}

export function createChannelLoginTransport(
  issuer: RuntimeHostDeliveryIssuer,
  port: number,
  fetcher: typeof fetch = fetch,
): ChannelLoginTransport {
  const url = `http://127.0.0.1:${port}/api/channels/login`;
  const pending = new Map<string, AbortController>();

  return {
    async login(input): Promise<ChannelLoginTransportResponse> {
      if (!isRequest(input)) return { status: 503, body: UNKNOWN };
      const key = JSON.stringify([input.channel, input.accountId ?? '']);
      if (input.action === 'cancel') {
        pending.get(key)?.abort();
        pending.delete(key);
      }

      const controller = new AbortController();
      if (input.action === 'start' || input.action === 'wait') {
        pending.get(key)?.abort();
        pending.set(key, controller);
      }
      try {
        const response = await fetcher(url, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${issuer.signDecision({
              principal: 'electron-main-local',
              endpoint: '/api/channels/login',
              scope: 'channels:write',
              capability: 'channels.login',
              subject: 'channel-login',
              expiresAt: Date.now() + DECISION_TTL_MS,
              revision: '1',
            })}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(input),
        });
        const body: unknown = await response.json();
        if (response.status === 400 && isRejected(body)) return { status: 400, body };
        if (response.status === 503 && isUnknown(body)) return { status: 503, body };
        if (response.status === 200 && isExpectedResponse(body, input)) {
          return { status: 200, body };
        }
      } catch {
        // Native errors, secrets, and QR data never cross the delivery error boundary.
      } finally {
        if (pending.get(key) === controller) pending.delete(key);
      }
      return { status: 503, body: UNKNOWN };
    },
  };
}

function isRequest(value: unknown): value is ChannelLoginRequest {
  if (!isRecord(value) || !isIdentity(value.channel)) return false;
  if (!['start', 'wait', 'cancel', 'logout'].includes(value.action)) return false;
  if (value.accountId !== undefined && !isIdentity(value.accountId)) return false;
  const keys = Object.keys(value);
  if (value.action === 'cancel' || value.action === 'logout') {
    return keys.every((key) => key === 'action' || key === 'channel' || key === 'accountId')
      && keys.length <= 3;
  }
  if (value.action === 'start') {
    return keys.every((key) => ['action', 'channel', 'accountId', 'config', 'force', 'timeoutMs'].includes(key))
      && (value.config === undefined || isConfig(value.config))
      && (value.force === undefined || typeof value.force === 'boolean')
      && (value.timeoutMs === undefined || isTimeout(value.timeoutMs));
  }
  if (keys.some((key) => !['action', 'channel', 'accountId', 'sessionKey', 'currentQrDataUrl', 'timeoutMs'].includes(key))) {
    return false;
  }
  if (value.sessionKey !== undefined && !isIdentity(value.sessionKey)) return false;
  if (value.currentQrDataUrl !== undefined && !isQrDataUrl(value.currentQrDataUrl)) return false;
  return value.timeoutMs === undefined || isTimeout(value.timeoutMs);
}

function isExpectedResponse(value: unknown, input: ChannelLoginRequest): value is LoginProgress | LogoutOutcome {
  if (input.action === 'logout') return isLogoutOutcome(value);
  if (input.action === 'cancel') return isCancelled(value);
  return isProgress(value);
}

function isProgress(value: unknown): value is LoginProgress {
  if (!isRecord(value)
    || (value.outcome !== 'progress'
      && value.outcome !== 'connected'
      && value.outcome !== 'target_rejected'
      && value.outcome !== 'unknown')) return false;
  if (!isIdentity(value.channel)) return false;
  return optionalIdentity(value.accountId)
    && optionalIdentity(value.sessionKey)
    && (value.qrDataUrl === undefined || isQrDataUrl(value.qrDataUrl));
}

function isCancelled(value: unknown): value is CancelledOutcome {
  return isRecord(value) && Object.keys(value).length === 1 && value.outcome === 'cancelled';
}

function isUnknown(value: unknown): value is typeof UNKNOWN {
  return isRecord(value) && Object.keys(value).length === 1 && value.outcome === 'unknown';
}

function isLogoutOutcome(value: unknown): value is LogoutOutcome {
  return isRecord(value)
    && Object.keys(value).length === 1
    && (value.outcome === 'confirmed' || value.outcome === 'target_rejected' || value.outcome === 'unknown');
}

function isRejected(value: unknown): value is RejectedResponse {
  return isRecord(value) && Object.keys(value).length === 1 && value.outcome === 'rejected';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function optionalIdentity(value: unknown): boolean {
  return value === undefined || isIdentity(value);
}

function isIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/\s/.test(value);
}

function isTimeout(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= MAX_TIMEOUT_MS;
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

function isQrDataUrl(value: unknown): value is string {
  return typeof value === 'string'
    && value.startsWith('data:image/png;base64,')
    && value.length <= 16_384;
}
