import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { hasExactKeys, isRecord, sendLoopbackJson } from '../client';
import { beginChannelTrace, channelTraceHeaders } from './trace';

const REQUEST_TIMEOUT_MS = 30_000;
const ENDPOINT = '/api/channels/config/read';
const UNAVAILABLE = {
  success: false,
  error: 'Channel configuration is unavailable',
} as const;

export type ChannelConfigReadRequest = Readonly<{
  channel: string;
  accountId?: string;
}>;

export type ChannelConfigReadProjection = Readonly<{
  values: Readonly<Record<string, string>>;
}>;

export interface ChannelConfigReadTransport {
  read(input: ChannelConfigReadRequest, traceId?: string): Promise<ChannelConfigReadProjection | null>;
}

export function createChannelConfigReadTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): ChannelConfigReadTransport {
  return {
    async read(input, traceId): Promise<ChannelConfigReadProjection | null> {
      if (!isRequest(input)) return null;

      const finish = beginChannelTrace('transport.config_read', traceId);
      let status = 503;
      let body: unknown;
      let errorCode: 'UNAVAILABLE' | 'INVALID_RESPONSE' | undefined;
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        path: ENDPOINT,
        issuer,
        decision: {
          endpoint: ENDPOINT,
          scope: 'channels:read',
          capability: 'channels.config.read',
          subject: 'channel-config-read',
        },
        method: 'POST',
        fetcher,
        headers: channelTraceHeaders(traceId),
        body: {
          channel: input.channel,
          ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
        },
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
      if (response === null) {
        body = UNAVAILABLE;
        errorCode = 'UNAVAILABLE';
      } else {
        status = response.status;
        body = response.body;
        if (response.status === 200 && isProjection(body)) {
          finish(status, body);
          return { values: body.values };
        }
        if ((response.status === 400 || response.status === 503) && isPublicError(body)) {
          finish(status, body);
          return null;
        }
        body = UNAVAILABLE;
        errorCode = 'INVALID_RESPONSE';
      }
      finish(status, body, errorCode);
      return null;
    },
  };
}

function isRequest(value: unknown): value is ChannelConfigReadRequest {
  if (!isRecord(value) || !isIdentity(value.channel)) return false;
  if (hasExactKeys(value, ['channel'])) return true;
  return hasExactKeys(value, ['channel', 'accountId']) && isIdentity(value.accountId);
}

function isProjection(value: unknown): value is ChannelConfigReadProjection {
  return isRecord(value)
    && hasExactKeys(value, ['values'])
    && isStringMap(value.values);
}

function isStringMap(value: unknown): value is Readonly<Record<string, string>> {
  return isRecord(value)
    && Object.entries(value).every(([key, item]) => isIdentity(key)
      && !isSensitiveKey(key)
      && typeof item === 'string');
}

function isSensitiveKey(key: string): boolean {
  return /(token|secret|password|credential|authorization|access.?key|private.?key|api.?key|error)/i.test(key);
}

function isPublicError(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['success', 'error'])
    && value.success === false
    && typeof value.error === 'string'
    && value.error.length <= 512
    && hasNoControlCharacters(value.error);
}

function hasNoControlCharacters(value: string): boolean {
  return [...value].every((character) => {
    const code = character.charCodeAt(0);
    return code >= 32 && code !== 127;
  });
}

function isIdentity(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 128
    && !value.includes('/')
    && !value.includes('\\')
    && [...value].every((character) => {
      const code = character.charCodeAt(0);
      return character.trim() === character && code >= 32 && code !== 127;
    });
}
