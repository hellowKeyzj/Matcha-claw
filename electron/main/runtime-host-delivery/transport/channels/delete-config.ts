import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import type { CallReceipt } from '../../../../../src/types/call-log';
import { decodeCallReceipt } from '../../../../../src/types/call-log/receipt';
import { hasExactKeys, isRecord, sendLoopbackJson } from '../client';
import { beginChannelTrace, channelTraceHeaders } from './trace';

type Rejected = Readonly<{ outcome: 'rejected' }>;
const UNKNOWN = { outcome: 'unknown' } as const;

export type ChannelDeleteConfigRequest = Readonly<{
  channel: string;
  accountId?: string;
}>;

export type ChannelDeleteConfigTransportResponse =
  | Readonly<{ status: 202; body: CallReceipt }>
  | Readonly<{ status: 400; body: Rejected }>
  | Readonly<{ status: 503; body: typeof UNKNOWN }>;

export interface ChannelDeleteConfigTransport {
  deleteConfig(input: ChannelDeleteConfigRequest, traceId?: string): Promise<ChannelDeleteConfigTransportResponse>;
}

export function createChannelDeleteConfigTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): ChannelDeleteConfigTransport {
  return {
    async deleteConfig(input, traceId): Promise<ChannelDeleteConfigTransportResponse> {
      if (!isRequest(input)) return { status: 503, body: UNKNOWN };
      const finish = beginChannelTrace('transport.delete', traceId);
      let status = 503;
      let outcome: unknown;
      let errorCode: 'INVALID_RESPONSE' | 'UNAVAILABLE' | undefined;
      try {
        const response = await sendLoopbackJson({
          port: runtimeHostTransportPort,
          path: '/api/channels/delete-config',
          issuer,
          decision: {
            endpoint: '/api/channels/delete-config',
            scope: 'channels:write',
            capability: 'channels.config.delete',
            subject: 'channel-config-delete',
          },
          method: 'POST',
          fetcher,
          body: input,
          headers: channelTraceHeaders(traceId),
        });
        status = response?.status ?? 503;
        outcome = response?.body ?? UNKNOWN;
        if (response?.status === 400 && isRejected(response.body)) return { status: 400, body: response.body };
        if (response?.status === 202) {
          try { return { status: 202, body: decodeCallReceipt(response.body) }; } catch { /* closed public boundary */ }
        }
        outcome = UNKNOWN;
        errorCode = response === null ? 'UNAVAILABLE' : 'INVALID_RESPONSE';
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

function isRejected(value: unknown): value is Rejected {
  return isRecord(value) && hasExactKeys(value, ['outcome']) && value.outcome === 'rejected';
}

function isIdentity(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 128
    && !value.split('').some((character) => /\s/.test(character) || character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}
