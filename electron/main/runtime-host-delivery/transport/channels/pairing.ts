import type { RuntimeHostDeliveryIssuer } from '../../bootstrap';

const DECISION_TTL_MS = 30_000;
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
  port: number,
  fetcher: typeof fetch = fetch,
): ChannelPairingTransport {
  const url = `http://127.0.0.1:${port}/api/channels/pairing`;
  return {
    async list(channel: string, accountId?: string): Promise<ChannelPairingTransportResponse> {
      if (!isIdentity(channel) || (accountId !== undefined && !isIdentity(accountId))) return { status: 400, body: UNAVAILABLE };
      try {
        const response = await fetcher(url, {
          method: 'POST',
          headers: signedHeaders(issuer, 'channels:read', 'channels.pairing.list'),
          body: JSON.stringify({
            channel,
            ...(accountId ? { accountId } : {}),
          }),
        });
        const body: unknown = await response.json();
        if (response.status === 200 && isPairingList(body)) return { status: 200, body };
      } catch {
        // Native transport details and raw pairing records stay private.
      }
      return { status: 503, body: UNAVAILABLE };
    },
    async approve(input): Promise<ChannelPairingApprovalResponse> {
      if (!isIdentity(input.channel)
        || !isApprovalCode(input.code)
        || (input.accountId !== undefined && !isIdentity(input.accountId))) {
        return { status: 400, body: UNAVAILABLE };
      }
      try {
        const response = await fetcher(url, {
          method: 'POST',
          headers: signedHeaders(issuer, 'channels:write', 'channels.pairing.approve'),
          body: JSON.stringify({
            action: 'approve',
            channel: input.channel,
            ...(input.accountId ? { accountId: input.accountId } : {}),
            code: input.code,
          }),
        });
        const body: unknown = await response.json();
        if (response.status === 200 && isApprovalResponse(body)) return { status: 200, body };
      } catch {
        // Native transport details and raw pairing records stay private.
      }
      return { status: 503, body: UNAVAILABLE };
    },
  };
}

function signedHeaders(
  issuer: RuntimeHostDeliveryIssuer,
  scope: 'channels:read' | 'channels:write',
  capability: 'channels.pairing.list' | 'channels.pairing.approve',
): Record<string, string> {
  return {
    Authorization: `Bearer ${issuer.signDecision({
      principal: 'electron-main-local',
      endpoint: '/api/channels/pairing',
      scope,
      capability,
      subject: 'channel-pairing',
      expiresAt: Date.now() + DECISION_TTL_MS,
      revision: '1',
    })}`,
    'Content-Type': 'application/json',
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
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return Object.keys(body).length === 1
    && Array.isArray(body.requests)
    && body.requests.every(isPairingRequest);
}

function isPairingRequest(value: unknown): value is PairingRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return Object.keys(request).every((key) => key === 'id' || key === 'createdAt' || key === 'lastSeenAt' || key === 'meta' || key === 'status')
    && typeof request.id === 'string'
    && request.id.length > 0
    && (request.createdAt === undefined || typeof request.createdAt === 'string')
    && (request.lastSeenAt === undefined || typeof request.lastSeenAt === 'string')
    && (request.meta === undefined || isPairingRequestMeta(request.meta))
    && (request.status === 'pending' || request.status === 'unknown');
}

function isPairingRequestMeta(value: unknown): value is Readonly<{ accountId: string }> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const meta = value as Record<string, unknown>;
  return Object.keys(meta).length === 1
    && typeof meta.accountId === 'string'
    && meta.accountId.length > 0;
}

function isApprovalResponse(value: unknown): value is Readonly<{ outcome: 'confirmed' | 'target_rejected' | 'unknown' }> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return Object.keys(body).length === 1
    && (body.outcome === 'confirmed' || body.outcome === 'target_rejected' || body.outcome === 'unknown');
}
