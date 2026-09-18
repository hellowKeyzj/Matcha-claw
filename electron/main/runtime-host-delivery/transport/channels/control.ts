import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { hasExactKeys, isRecord, sendLoopbackJson } from '../client';

const CHANNEL_CONTROL_PATH = '/api/channels/control';
const UNAVAILABLE = {
  success: false,
  error: 'Channel control is unavailable',
} as const;

export type ChannelControlAction = 'connect' | 'disconnect';
export type ChannelControlOutcome = 'confirmed' | 'target_rejected' | 'unknown';

export type ChannelControlTransportResponse = Readonly<{
  status: 200 | 503;
  body: Readonly<{ outcome: ChannelControlOutcome }> | typeof UNAVAILABLE;
}>;

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
      if (response?.status === 200 && isChannelControl(response.body)) {
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
