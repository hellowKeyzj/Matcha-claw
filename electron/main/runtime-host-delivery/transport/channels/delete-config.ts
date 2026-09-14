import type { RuntimeHostDeliveryIssuer } from '../../bootstrap';
import { beginChannelTrace, channelTraceError, channelTraceHeaders } from './catalog';

const DECISION_TTL_MS = 30_000;
type Rejected = Readonly<{ outcome: 'rejected' }>;
const UNKNOWN = { outcome: 'unknown' } as const;

export type ChannelDeleteConfigRequest = Readonly<{
  channel: string;
  accountId?: string;
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
  deleteConfig(input: ChannelDeleteConfigRequest, traceId?: string): Promise<ChannelDeleteConfigTransportResponse>;
}

export function createChannelDeleteConfigTransport(
  issuer: RuntimeHostDeliveryIssuer,
  port: number,
  fetcher: typeof fetch = fetch,
): ChannelDeleteConfigTransport {
  const url = `http://127.0.0.1:${port}/api/channels/delete-config`;
  return {
    async deleteConfig(input, traceId): Promise<ChannelDeleteConfigTransportResponse> {
      if (!isRequest(input)) return { status: 503, body: UNKNOWN };
      const finish = beginChannelTrace('transport.delete', traceId);
      let status = 503;
      let outcome: unknown;
      let errorCode: ReturnType<typeof channelTraceError> | 'INVALID_RESPONSE' | undefined;
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
            ...channelTraceHeaders(traceId),
          },
          body: JSON.stringify(input),
        });
        status = response.status;
        const body: unknown = await response.json();
        outcome = body;
        if (response.status === 400 && isRejected(body)) return { status: 400, body };
        if (response.status === 200 && isOutcome(body)) return { status: 200, body };
        outcome = UNKNOWN;
        errorCode = 'INVALID_RESPONSE';
      } catch (error) {
        outcome = UNKNOWN;
        errorCode = channelTraceError(error);
      } finally {
        finish(status, outcome, errorCode);
      }
      return { status: 503, body: UNKNOWN };
    },
  };
}

function isRequest(value: ChannelDeleteConfigRequest): boolean {
  return isRecord(value)
    && Object.keys(value).every((key) => key === 'channel' || key === 'accountId')
    && isIdentity(value.channel)
    && (value.accountId === undefined || isIdentity(value.accountId));
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
