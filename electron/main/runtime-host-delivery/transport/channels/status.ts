import type { RuntimeHostDeliveryIssuer } from '../../bootstrap';

const DECISION_TTL_MS = 30_000;
const PUBLIC_STATUS_ERROR = 'Channel status reported an error';
const UNAVAILABLE = {
  success: false,
  error: 'Channel status is unavailable',
} as const;

type ChannelConnection = 'connected' | 'disconnected' | 'unknown';

type ChannelAccount = Readonly<{
  channel: string;
  accountId: string;
  connection: ChannelConnection;
}>;

type ChannelSummarySnapshot = Readonly<{
  configured?: boolean;
  running?: boolean;
  error?: string;
  lastError?: string;
}>;

type ChannelAccountSnapshot = Readonly<{
  accountId: string;
  configured?: boolean;
  connected?: boolean;
  running?: boolean;
  linked?: boolean;
  lastError?: string;
  name?: string;
  lastConnectedAt?: number | null;
  lastInboundAt?: number | null;
  lastOutboundAt?: number | null;
  lastProbeAt?: number | null;
  probe?: Readonly<{ ok: boolean }>;
}>;

export type ChannelSnapshot = Readonly<{
  ts: number;
  ready?: boolean;
  refreshing?: boolean;
  error?: string;
  channelOrder: readonly string[];
  channels: Readonly<Record<string, ChannelSummarySnapshot>>;
  channelAccounts: Readonly<Record<string, readonly ChannelAccountSnapshot[]>>;
  channelDefaultAccountId: Readonly<Record<string, string>>;
}>;

export type ChannelStatusTransportResponse = Readonly<{
  status: 200 | 503;
  body: Readonly<{ accounts: readonly ChannelAccount[] }> | typeof UNAVAILABLE;
}>;

export type ChannelSnapshotTransportResponse = Readonly<{
  status: 200 | 503;
  body: ChannelSnapshot | typeof UNAVAILABLE;
}>;

export interface ChannelStatusTransport {
  read(): Promise<ChannelStatusTransportResponse>;
  readSnapshot(): Promise<ChannelSnapshotTransportResponse>;
}

export function createChannelStatusTransport(
  issuer: RuntimeHostDeliveryIssuer,
  port: number,
  fetcher: typeof fetch = fetch,
): ChannelStatusTransport {
  const url = `http://127.0.0.1:${port}/api/channels/status`;
  return {
    async read(): Promise<ChannelStatusTransportResponse> {
      try {
        const response = await fetcher(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${issuer.signDecision({
              principal: 'electron-main-local',
              endpoint: '/api/channels/status',
              scope: 'channels:read',
              capability: 'channels.status.read',
              subject: 'channel-status',
              expiresAt: Date.now() + DECISION_TTL_MS,
              revision: '1',
            })}`,
            'Content-Type': 'application/json',
          },
          body: '{}',
        });
        const body: unknown = await response.json();
        if (response.status === 200 && isChannelStatus(body)) {
          return { status: 200, body };
        }
      } catch {
        // Native transport details do not cross the Electron delivery boundary.
      }
      return { status: 503, body: UNAVAILABLE };
    },

    async readSnapshot(): Promise<ChannelSnapshotTransportResponse> {
      try {
        const response = await fetcher(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${issuer.signDecision({
              principal: 'electron-main-local',
              endpoint: '/api/channels/status',
              scope: 'channels:read',
              capability: 'channels.snapshot.read',
              subject: 'channel-status',
              expiresAt: Date.now() + DECISION_TTL_MS,
              revision: '1',
            })}`,
            'Content-Type': 'application/json',
          },
          body: '{"operation":"snapshot"}',
        });
        const body: unknown = await response.json();
        if (response.status === 200 && isChannelSnapshot(body)) {
          return { status: 200, body };
        }
      } catch {
        // Native transport details do not cross the Electron delivery boundary.
      }
      return { status: 503, body: UNAVAILABLE };
    },
  };
}

function isChannelStatus(value: unknown): value is Readonly<{ accounts: readonly ChannelAccount[] }> {
  return isRecord(value)
    && hasExactKeys(value, ['accounts'])
    && Array.isArray(value.accounts)
    && value.accounts.every(isChannelAccount);
}

function isChannelAccount(value: unknown): value is ChannelAccount {
  return isRecord(value)
    && hasExactKeys(value, ['channel', 'accountId', 'connection'])
    && isIdentifier(value.channel)
    && isIdentifier(value.accountId)
    && (value.connection === 'connected'
      || value.connection === 'disconnected'
      || value.connection === 'unknown');
}

export function isChannelSnapshot(value: unknown): value is ChannelSnapshot {
  if (!isRecord(value)
    || !hasOnlyKeys(value, [
      'ts', 'ready', 'refreshing', 'error', 'channelOrder', 'channels', 'channelAccounts', 'channelDefaultAccountId',
    ])
    || !Object.hasOwn(value, 'ts')
    || !Object.hasOwn(value, 'channelOrder')
    || !Object.hasOwn(value, 'channels')
    || !Object.hasOwn(value, 'channelAccounts')
    || !Object.hasOwn(value, 'channelDefaultAccountId')
    || !isOptionalSnapshotBoolean(value, 'ready')
    || !isOptionalSnapshotBoolean(value, 'refreshing')
    || !isOptionalPublicError(value, 'error')
    || !isSafeTimestamp(value.ts)
    || !Array.isArray(value.channelOrder)
    || !value.channelOrder.every(isIdentifier)
    || !isRecord(value.channels)
    || !isRecord(value.channelAccounts)
    || !isRecord(value.channelDefaultAccountId)) {
    return false;
  }

  const channelOrder = value.channelOrder;
  if (new Set(channelOrder).size !== channelOrder.length
    || !hasExactMapKeys(value.channels, channelOrder)
    || !hasExactMapKeys(value.channelAccounts, channelOrder)
    || !hasExactMapKeys(value.channelDefaultAccountId, channelOrder)) {
    return false;
  }

  return channelOrder.every((channel) => isChannelSummary(value.channels[channel])
    && Array.isArray(value.channelAccounts[channel])
    && value.channelAccounts[channel].every(isChannelAccountSnapshot)
    && hasUniqueAccountIds(value.channelAccounts[channel])
    && isIdentifier(value.channelDefaultAccountId[channel]));
}

function hasUniqueAccountIds(value: unknown): boolean {
  return Array.isArray(value)
    && value.every(isChannelAccountSnapshot)
    && new Set(value.map((account) => account.accountId)).size === value.length;
}

function isChannelSummary(value: unknown): value is ChannelSummarySnapshot {
  return isRecord(value)
    && hasOnlyKeys(value, ['configured', 'running', 'error', 'lastError'])
    && isOptionalBoolean(value, 'configured')
    && isOptionalBoolean(value, 'running')
    && isOptionalPublicError(value, 'error')
    && isOptionalPublicError(value, 'lastError');
}

function isChannelAccountSnapshot(value: unknown): value is ChannelAccountSnapshot {
  return isRecord(value)
    && hasOnlyKeys(value, [
      'accountId', 'configured', 'connected', 'running', 'linked', 'lastError', 'name',
      'lastConnectedAt', 'lastInboundAt', 'lastOutboundAt', 'lastProbeAt', 'probe',
    ])
    && isIdentifier(value.accountId)
    && isOptionalBoolean(value, 'configured')
    && isOptionalBoolean(value, 'connected')
    && isOptionalBoolean(value, 'running')
    && isOptionalBoolean(value, 'linked')
    && isOptionalPublicError(value, 'lastError')
    && isOptionalText(value, 'name')
    && isOptionalTimestamp(value, 'lastConnectedAt')
    && isOptionalTimestamp(value, 'lastInboundAt')
    && isOptionalTimestamp(value, 'lastOutboundAt')
    && isOptionalTimestamp(value, 'lastProbeAt')
    && isOptionalProbe(value, 'probe');
}

function isOptionalBoolean(value: Record<string, unknown>, key: string): boolean {
  return !Object.hasOwn(value, key) || typeof value[key] === 'boolean';
}

function isOptionalSnapshotBoolean(value: Record<string, unknown>, key: string): boolean {
  return !Object.hasOwn(value, key) || typeof value[key] === 'boolean';
}

function isOptionalPublicError(value: Record<string, unknown>, key: string): boolean {
  return !Object.hasOwn(value, key) || value[key] === PUBLIC_STATUS_ERROR;
}

function isOptionalText(value: Record<string, unknown>, key: string): boolean {
  return !Object.hasOwn(value, key) || isText(value[key]);
}

function isOptionalTimestamp(value: Record<string, unknown>, key: string): boolean {
  return !Object.hasOwn(value, key) || value[key] === null || isSafeTimestamp(value[key]);
}

function isOptionalProbe(value: Record<string, unknown>, key: string): boolean {
  return !Object.hasOwn(value, key)
    || (isRecord(value[key]) && hasExactKeys(value[key], ['ok']) && typeof value[key].ok === 'boolean');
}

function isIdentifier(value: unknown): value is string {
  return isText(value) && value.length <= 128;
}

function isText(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 4_096
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function isSafeTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function hasExactMapKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return hasExactKeys(value, expected);
}
