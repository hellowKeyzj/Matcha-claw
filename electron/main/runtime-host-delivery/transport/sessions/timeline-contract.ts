import { hasExactKeys, isRecord } from '../client';
import { isEndpoint, type SessionIdentity } from './session-contract';

export function isTimelineIdentity(value: unknown): value is SessionIdentity {
  return isRecord(value) && hasExactKeys(value, ['endpoint', 'agentId', 'sessionKey'])
    && isEndpoint(value.endpoint)
    && isBoundedId(value.agentId)
    && isBoundedId(value.sessionKey);
}

export function isTimelineScope(value: unknown): value is { kind: 'session'; identity: SessionIdentity } {
  return isRecord(value) && hasExactKeys(value, ['kind', 'identity'])
    && value.kind === 'session' && isTimelineIdentity(value.identity);
}

export function isBoundedId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= 4096
    && value.trim() === value
    && !value.includes('\0');
}
