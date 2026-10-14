import type { CallDetailByModule } from '../call-log';

const outcomes = [
  null, 'queued', 'started', 'succeeded', 'responded', 'subscribed', 'released', 'complete', 'incomplete', 'notFound',
  'rejected', 'unknown', 'unsupported', 'unavailable', 'protocol', 'deadline',
] as const;
const validOutcomes = new Set<unknown>(outcomes);

/** Opaque SHA-256 references are not native IDs, message identity or call identity. */
export interface SessionsCallDetail {
  provider: 'openclaw' | 'matcha-agent' | null;
  sessionRef: string | null;
  nativeSessionRef: string | null;
  runRef: string | null;
  outcome: typeof outcomes[number];
  count: number | null;
  seq: number | null;
}

declare module '../call-log' {
  interface CallDetailByModule {
    sessions: SessionsCallDetail;
  }
}

export type SessionsCallSummary = CallDetailByModule['sessions'];

const fields = ['provider', 'sessionRef', 'nativeSessionRef', 'runRef', 'outcome', 'count', 'seq'];

export function decodeSessionsCallDetail(value: unknown): SessionsCallDetail | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const detail = value as Record<string, unknown>;
  if (Object.keys(detail).length !== fields.length
    || !fields.every((field) => Object.hasOwn(detail, field))
    || (detail.provider !== null && detail.provider !== 'openclaw' && detail.provider !== 'matcha-agent')
    || ![detail.sessionRef, detail.nativeSessionRef, detail.runRef].every(
      (reference) => reference === null || (typeof reference === 'string' && /^[a-f0-9]{64}$/.test(reference)),
    )
    || !validOutcomes.has(detail.outcome)
    || ![detail.count, detail.seq].every(
      (count) => count === null || (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0),
    )) return undefined;
  return {
    provider: detail.provider,
    sessionRef: detail.sessionRef as string | null,
    nativeSessionRef: detail.nativeSessionRef as string | null,
    runRef: detail.runRef as string | null,
    outcome: detail.outcome as SessionsCallDetail['outcome'],
    count: detail.count as number | null,
    seq: detail.seq as number | null,
  };
}
