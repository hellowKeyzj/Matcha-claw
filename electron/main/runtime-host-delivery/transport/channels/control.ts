import type { RuntimeHostDeliveryIssuer } from '../../bootstrap';

const DECISION_TTL_MS = 30_000;
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
  port: number,
  fetcher: typeof fetch = fetch,
): ChannelControlTransport {
  const url = `http://127.0.0.1:${port}/api/channels/control`;
  return {
    async control(input): Promise<ChannelControlTransportResponse> {
      if (!isIdentity(input.channel) || !isIdentity(input.accountId)) {
        return { status: 503, body: UNAVAILABLE };
      }
      try {
        const response = await fetcher(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${issuer.signDecision({
              principal: 'electron-main-local',
              endpoint: '/api/channels/control',
              scope: 'channels:write',
              capability: 'channels.runtime.control',
              subject: 'channel-control',
              expiresAt: Date.now() + DECISION_TTL_MS,
              revision: '1',
            })}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(input),
        });
        const body: unknown = await response.json();
        if (response.status === 200 && isChannelControl(body)) {
          return { status: 200, body };
        }
      } catch {
        // Native transport details do not cross the Electron delivery boundary.
      }
      return { status: 503, body: UNAVAILABLE };
    },
  };
}

function isIdentity(value: string): boolean {
  return value.length > 0 && value.length <= 128 && !/\s/.test(value);
}

function isChannelControl(value: unknown): value is Readonly<{ outcome: ChannelControlOutcome }> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return Object.keys(body).length === 1
    && (body.outcome === 'confirmed' || body.outcome === 'target_rejected' || body.outcome === 'unknown');
}
