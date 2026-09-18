import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { hasExactKeys, isRecord, sendLoopbackJson } from '../client';

const PAIRING_PATH = '/api/channels/pairing';
const UNAVAILABLE = {
  success: false,
  error: 'Channel pairing is unavailable',
} as const;

type PairingRequest = Readonly<{
  id: string;
  createdAt?: string;
  lastSeenAt?: string;
  meta?: Readonly<{ accountId: string }>;
  status: 'pending' | 'unknown';
}>;

type ChannelPairingApprovalResponse = Readonly<{
  status: 200 | 400 | 503;
  body: Readonly<{ outcome: 'confirmed' | 'target_rejected' | 'unknown' }> | typeof UNAVAILABLE;
}>;

export type ChannelPairingTransportResponse = Readonly<{
  status: 200 | 400 | 503;
  body: Readonly<{ requests: readonly PairingRequest[] }> | typeof UNAVAILABLE;
}>;

export interface ChannelPairingTransport {
  list(channel: string, accountId?: string): Promise<ChannelPairingTransportResponse>;
  approve(input: Readonly<{ channel: string; accountId?: string; code: string }>): Promise<ChannelPairingApprovalResponse>;
}

export function createChannelPairingTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): ChannelPairingTransport {
  return {
    async list(channel: string, accountId?: string): Promise<ChannelPairingTransportResponse> {
      if (!isIdentity(channel) || (accountId !== undefined && !isIdentity(accountId))) return { status: 400, body: UNAVAILABLE };
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        path: PAIRING_PATH,
        issuer,
        decision: {
          endpoint: PAIRING_PATH,
          scope: 'channels:read',
          capability: 'channels.pairing.list',
          subject: 'channel-pairing',
        },
        method: 'POST',
        fetcher,
        body: {
          channel,
          ...(accountId ? { accountId } : {}),
        },
      });
      if (response?.status === 200 && isPairingList(response.body)) return { status: 200, body: response.body };
      return { status: 503, body: UNAVAILABLE };
    },
    async approve(input): Promise<ChannelPairingApprovalResponse> {
      if (!isIdentity(input.channel)
        || !isApprovalCode(input.code)
        || (input.accountId !== undefined && !isIdentity(input.accountId))) {
        return { status: 400, body: UNAVAILABLE };
      }
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        path: PAIRING_PATH,
        issuer,
        decision: {
          endpoint: PAIRING_PATH,
          scope: 'channels:write',
          capability: 'channels.pairing.approve',
          subject: 'channel-pairing',
        },
        method: 'POST',
        fetcher,
        body: {
          action: 'approve',
          channel: input.channel,
          ...(input.accountId ? { accountId: input.accountId } : {}),
          code: input.code,
        },
      });
      if (response?.status === 200 && isApprovalResponse(response.body)) return { status: 200, body: response.body };
      return { status: 503, body: UNAVAILABLE };
    },
  };
}

function isIdentity(value: string): boolean {
  return value.length > 0
    && value.length <= 128
    && [...value].every((character) => {
      const code = character.charCodeAt(0);
      return !/\s/.test(character) && code >= 32 && code !== 127;
    });
}

function isApprovalCode(value: string): boolean {
  return /^[A-Za-z0-9]{1,128}$/.test(value);
}

function isPairingList(value: unknown): value is Readonly<{ requests: readonly PairingRequest[] }> {
  return isRecord(value)
    && hasExactKeys(value, ['requests'])
    && Array.isArray(value.requests)
    && value.requests.every(isPairingRequest);
}

function isPairingRequest(value: unknown): value is PairingRequest {
  if (!isRecord(value)) return false;
  return Object.keys(value).every((key) => key === 'id' || key === 'createdAt' || key === 'lastSeenAt' || key === 'meta' || key === 'status')
    && typeof value.id === 'string'
    && value.id.length > 0
    && (value.createdAt === undefined || typeof value.createdAt === 'string')
    && (value.lastSeenAt === undefined || typeof value.lastSeenAt === 'string')
    && (value.meta === undefined || isPairingRequestMeta(value.meta))
    && (value.status === 'pending' || value.status === 'unknown');
}

function isPairingRequestMeta(value: unknown): value is Readonly<{ accountId: string }> {
  return isRecord(value)
    && hasExactKeys(value, ['accountId'])
    && typeof value.accountId === 'string'
    && value.accountId.length > 0;
}

function isApprovalResponse(value: unknown): value is Readonly<{ outcome: 'confirmed' | 'target_rejected' | 'unknown' }> {
  return isRecord(value)
    && hasExactKeys(value, ['outcome'])
    && (value.outcome === 'confirmed' || value.outcome === 'target_rejected' || value.outcome === 'unknown');
}
