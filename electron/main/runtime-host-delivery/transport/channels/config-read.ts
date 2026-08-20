import type { RuntimeHostDeliveryIssuer } from '../../bootstrap';

const DECISION_TTL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;
const ENDPOINT = '/api/channels/config/read';

export type ChannelConfigReadRequest = Readonly<{
  channel: string;
  accountId?: string;
}>;

export type ChannelConfigReadProjection = Readonly<{
  values: Readonly<Record<string, string>>;
}>;

export interface ChannelConfigReadTransport {
  read(input: ChannelConfigReadRequest): Promise<ChannelConfigReadProjection | null>;
}

export function createChannelConfigReadTransport(
  issuer: RuntimeHostDeliveryIssuer,
  port: number,
  fetcher: typeof fetch = fetch,
): ChannelConfigReadTransport {
  const url = `http://127.0.0.1:${port}${ENDPOINT}`;
  return {
    async read(input): Promise<ChannelConfigReadProjection | null> {
      if (!isRequest(input)) return null;

      const controller = new AbortController();
      const requestTimeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetcher(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${issuer.signDecision({
              principal: 'electron-main-local',
              endpoint: ENDPOINT,
              scope: 'channels:read',
              capability: 'channels.config.read',
              subject: 'channel-config-read',
              expiresAt: Date.now() + DECISION_TTL_MS,
              revision: '1',
            })}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            channel: input.channel,
            ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
          }),
          signal: controller.signal,
        });
        const body: unknown = await response.json();
        if (response.status === 200 && isProjection(body)) {
          return { values: body.values };
        }
        if ((response.status === 400 || response.status === 503) && isPublicError(body)) {
          return null;
        }
      } catch {
        // Native errors and configuration values never cross the delivery boundary.
      } finally {
        clearTimeout(requestTimeout);
      }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
