import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import type { CallReceipt } from '../../../../../src/types/call-log';
import { decodeCallReceipt } from '../../../../../src/types/call-log/receipt';
import { hasExactKeys, isRecord, sendLoopbackJson } from '../client';

const CHANNEL_CONTROL_PATH = '/api/channels/control';
const UNAVAILABLE = {
  success: false,
  error: 'Channel control is unavailable',
} as const;

export type ChannelControlAction = 'connect' | 'disconnect';
export type ChannelControlOutcome = 'confirmed' | 'target_rejected' | 'unknown';

export type ChannelControlTransportResponse =
  | Readonly<{ status: 202; body: CallReceipt }>
  | Readonly<{ status: 200; body: Readonly<{ outcome: ChannelControlOutcome }> }>
  | Readonly<{ status: 503; body: typeof UNAVAILABLE }>;

export interface ChannelControlTransport {
  control(input: Readonly<{
    action: ChannelControlAction;
    channel: string;
    accountId: string;
  }>): Promise<ChannelControlTransportResponse>;
}

export function createChannelControlTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): ChannelControlTransport {
  return {
    async control(input): Promise<ChannelControlTransportResponse> {
      if (!isIdentity(input.channel) || !isIdentity(input.accountId)) {
        return { status: 503, body: UNAVAILABLE };
      }
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        path: CHANNEL_CONTROL_PATH,
        issuer,
        decision: {
          endpoint: CHANNEL_CONTROL_PATH,
          scope: 'channels:write',
          capability: 'channels.runtime.control',
          subject: 'channel-control',
        },
        method: 'POST',
        fetcher,
        body: input,
      });
      if (input.action === 'disconnect' && response?.status === 202) {
        try { return { status: 202, body: decodeCallReceipt(response.body) }; } catch { /* closed public boundary */ }
      }
      if (input.action === 'connect' && response?.status === 200 && isChannelControl(response.body)) {
        return { status: 200, body: response.body };
      }
      return { status: 503, body: UNAVAILABLE };
    },
  };
}

function isIdentity(value: string): boolean {
  return value.length > 0 && value.length <= 128 && !/\s/.test(value);
}

function isChannelControl(value: unknown): value is Readonly<{ outcome: ChannelControlOutcome }> {
  return isRecord(value)
    && hasExactKeys(value, ['outcome'])
    && (value.outcome === 'confirmed' || value.outcome === 'target_rejected' || value.outcome === 'unknown');
}
