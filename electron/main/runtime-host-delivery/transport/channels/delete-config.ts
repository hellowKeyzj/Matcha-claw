import type { RuntimeHostDeliveryIssuer } from '../../bootstrap';

const DECISION_TTL_MS = 30_000;
type Rejected = Readonly<{ outcome: 'rejected' }>;
const UNKNOWN = { outcome: 'unknown' } as const;

export type ChannelDeleteConfigRequest = Readonly<{
  channel: string;
  accountId: string;
}>;

export type ChannelDeleteConfigOutcome = 'confirmed' | 'target_rejected' | 'unknown';

export type ChannelDeleteConfigTransportResponse = Readonly<{
  status: 200 | 400 | 503;
  body:
    | Readonly<{ outcome: ChannelDeleteConfigOutcome }>
    | Rejected
    | typeof UNKNOWN;
}>;

export interface ChannelDeleteConfigTransport {
  deleteConfig(input: ChannelDeleteConfigRequest): Promise<ChannelDeleteConfigTransportResponse>;
}

export function createChannelDeleteConfigTransport(
  issuer: RuntimeHostDeliveryIssuer,
  port: number,
  fetcher: typeof fetch = fetch,
): ChannelDeleteConfigTransport {
  const url = `http://127.0.0.1:${port}/api/channels/delete-config`;
  return {
    async deleteConfig(input): Promise<ChannelDeleteConfigTransportResponse> {
      if (!isRequest(input)) return { status: 503, body: UNKNOWN };
      try {
        const response = await fetcher(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${issuer.signDecision({
              principal: 'electron-main-local',
              endpoint: '/api/channels/delete-config',
              scope: 'channels:write',
              capability: 'channels.config.delete',
              subject: 'channel-config-delete',
              expiresAt: Date.now() + DECISION_TTL_MS,
              revision: '1',
            })}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(input),
        });
        const body: unknown = await response.json();
        if (response.status === 400 && isRejected(body)) return { status: 400, body };
        if (response.status === 200 && isOutcome(body)) return { status: 200, body };
      } catch {
        // Native transport details and secrets never cross the Electron delivery boundary.
      }
      return { status: 503, body: UNKNOWN };
    },
  };
}

function isRequest(value: ChannelDeleteConfigRequest): boolean {
  return value !== null
    && typeof value === 'object'
    && Object.keys(value).length === 2
    && isIdentity(value.channel)
    && isIdentity(value.accountId);
}

function isOutcome(value: unknown): value is Readonly<{ outcome: ChannelDeleteConfigOutcome }> {
  return isRecord(value)
    && Object.keys(value).length === 1
    && (value.outcome === 'confirmed' || value.outcome === 'target_rejected' || value.outcome === 'unknown');
}

function isRejected(value: unknown): value is Rejected {
  return isRecord(value) && Object.keys(value).length === 1 && value.outcome === 'rejected';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isIdentity(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 128
    && !value.split('').some((character) => /\s/.test(character) || character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}
