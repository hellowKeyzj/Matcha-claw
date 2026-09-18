import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { hasExactKeys, isRecord, sendLoopbackJson } from '../client';
import { beginChannelTrace, channelTraceHeaders } from './trace';

const MAX_CONFIG_KEYS = 64;
const MAX_CONFIG_VALUE_LENGTH = 131_072;
const MAX_CONFIG_TOTAL_LENGTH = 262_144;
const MAX_PUBLIC_LIST_ITEMS = 32;
const MAX_PUBLIC_TEXT_LENGTH = 512;
const MAX_DETAIL_TEXT_LENGTH = 256;
const ENDPOINT = '/api/channels/credentials/validate';
const UNAVAILABLE = {
  success: false,
  error: 'Channel credentials validation is unavailable',
} as const;

const PUBLIC_DETAIL_KEYS = new Set([
  'basicId',
  'botId',
  'botName',
  'botOpenId',
  'botUsername',
  'channelName',
  'guildName',
  'id',
  'userId',
  'username',
]);

export type ChannelCredentialsRequest = Readonly<{
  channelType: string;
  config: Readonly<Record<string, string>>;
}>;

export type ChannelCredentialsValidation = Readonly<{
  success: boolean;
  valid?: boolean;
  errors?: readonly string[];
  warnings?: readonly string[];
  details?: Readonly<Record<string, string>>;
}>;

export type ChannelCredentialsTransportResponse = Readonly<{
  status: 200 | 400 | 503;
  body: ChannelCredentialsValidation | typeof UNAVAILABLE;
}>;

export interface ChannelCredentialsTransport {
  validate(input: ChannelCredentialsRequest, traceId?: string): Promise<ChannelCredentialsTransportResponse>;
}

export function createChannelCredentialsTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): ChannelCredentialsTransport {
  return {
    async validate(input, traceId): Promise<ChannelCredentialsTransportResponse> {
      if (!isChannelCredentialsRequest(input)) return { status: 503, body: UNAVAILABLE };
      const finish = beginChannelTrace('transport.credentials.validate', traceId);
      let status = 503;
      let body: unknown;
      let errorCode: 'UNAVAILABLE' | 'INVALID_RESPONSE' | undefined;
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        path: ENDPOINT,
        issuer,
        decision: {
          endpoint: ENDPOINT,
          scope: 'channels:write',
          capability: 'channels.credentials.validate',
          subject: 'channel-credentials',
        },
        method: 'POST',
        fetcher,
        headers: channelTraceHeaders(traceId),
        body: input,
      });
      if (response === null) {
        body = UNAVAILABLE;
        errorCode = 'UNAVAILABLE';
      } else {
        status = response.status;
        body = response.body;
        if ((response.status === 200 || response.status === 400)
          && isChannelCredentialsValidation(body, input.config)) {
          finish(status, body);
          return { status: response.status, body };
        }
        body = UNAVAILABLE;
        errorCode = 'INVALID_RESPONSE';
      }
      finish(status, body, errorCode);
      return { status: 503, body: UNAVAILABLE };
    },
  };
}

export function isChannelCredentialsRequest(value: unknown): value is ChannelCredentialsRequest {
  return isRecord(value)
    && hasExactKeys(value, ['channelType', 'config'])
    && isIdentity(value.channelType)
    && isConfig(value.config);
}

export function isChannelCredentialsValidation(
  value: unknown,
  config: Readonly<Record<string, string>>,
): value is ChannelCredentialsValidation {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['success', 'valid', 'errors', 'warnings', 'details'])
    || typeof value.success !== 'boolean'
    || (value.valid !== undefined && typeof value.valid !== 'boolean')
    || (value.errors !== undefined && !isPublicStringList(value.errors))
    || (value.warnings !== undefined && !isPublicStringList(value.warnings))
    || (value.details !== undefined && !isPublicDetails(value.details))) {
    return false;
  }
  return !containsCandidateSecret(value, config);
}

function isConfig(value: unknown): value is Readonly<Record<string, string>> {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length > MAX_CONFIG_KEYS) return false;
  let totalLength = 0;
  for (const key of keys) {
    const item = value[key];
    if (!isIdentity(key) || typeof item !== 'string' || item.length > MAX_CONFIG_VALUE_LENGTH) {
      return false;
    }
    totalLength += item.length;
    if (totalLength > MAX_CONFIG_TOTAL_LENGTH) return false;
  }
  return true;
}

function isPublicStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value)
    && value.length <= MAX_PUBLIC_LIST_ITEMS
    && value.every((item) => isPublicText(item, MAX_PUBLIC_TEXT_LENGTH));
}

function isPublicDetails(value: unknown): value is Readonly<Record<string, string>> {
  if (!isRecord(value)) return false;
  return Object.keys(value).every((key) => PUBLIC_DETAIL_KEYS.has(key))
    && Object.values(value).every((item) => isPublicText(item, MAX_DETAIL_TEXT_LENGTH));
}

function isPublicText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string'
    && value.length <= maxLength
    && [...value].every((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    });
}

function containsCandidateSecret(
  value: ChannelCredentialsValidation,
  config: Readonly<Record<string, string>>,
): boolean {
  const publicText = JSON.stringify({
    errors: value.errors,
    warnings: value.warnings,
    details: value.details,
  });
  return Object.entries(config).some(([key, candidate]) => isSensitiveKey(key)
    && candidate.length >= 4
    && publicText.includes(candidate));
}

function isSensitiveKey(key: string): boolean {
  return /(token|secret|password|credential|authorization|access.?key|private.?key|api.?key)/i.test(key);
}

function isIdentity(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 128
    && [...value].every((character) => {
      const code = character.charCodeAt(0);
      return !/\s/.test(character) && code >= 32 && code !== 127;
    });
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
