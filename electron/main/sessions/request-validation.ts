import { hasExactKeys, isRecord } from '../runtime-host-delivery/transport/client';
import { isEndpoint as isRuntimeEndpoint, type SessionIdentity } from '../runtime-host-delivery/transport/sessions/session-contract';
import { summarizeIdentifier } from '../runtime-host-delivery/transport/sessions/trace';

export function hasAllowedKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

export function isIdentifier(value: unknown, maxBytes = 4096): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= maxBytes && !value.includes('\0');
}

export function isSafeFileName(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 255
    && !value.includes('/')
    && !value.includes('\\')
    && !hasControlCharacter(value)
    && value !== '.'
    && value !== '..';
}

export function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
}

export function isSessionIdentity(value: unknown): value is SessionIdentity {
  return isRecord(value)
    && hasExactKeys(value, ['endpoint', 'agentId', 'sessionKey'])
    && isRuntimeEndpoint(value.endpoint)
    && isIdentifier(value.agentId)
    && isIdentifier(value.sessionKey);
}

export function summarizeString(value: unknown): { present: boolean; length: number } {
  return summarizeIdentifier(typeof value === 'string' ? value : null);
}
