import type { CallDetailByModule } from '../call-log';

export type UsageCallFailure =
  | 'admissionClosed'
  | 'ownerUnavailable'
  | 'recordingUnavailable'
  | 'runtimeUnavailable';

export type UsageCallDetail =
  | {
      kind: 'recent';
      period: 'all';
      limit: number;
      entryCount: number | null;
      failure: UsageCallFailure | null;
    }
  | {
      kind: 'sessionTimeseries';
      period: 'all';
      entryCount: number | null;
      failure: UsageCallFailure | null;
    };

declare module '../call-log' {
  interface CallDetailByModule {
    usage: UsageCallDetail;
  }
}

export type UsageCallSummary = CallDetailByModule['usage'];

export function decodeUsageCallDetail(value: unknown): UsageCallDetail | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const detail = value as Record<string, unknown>;
  if (detail.period !== 'all'
    || (detail.failure !== null && detail.failure !== 'admissionClosed'
      && detail.failure !== 'ownerUnavailable' && detail.failure !== 'recordingUnavailable'
      && detail.failure !== 'runtimeUnavailable')
    || (detail.entryCount !== null && !isCount(detail.entryCount))
    || (detail.failure !== null && detail.entryCount !== null)) return null;
  const { period, entryCount, failure } = detail;
  if (detail.kind === 'recent') {
    if (!hasKeys(detail, ['kind', 'period', 'limit', 'entryCount', 'failure'])
      || !isCount(detail.limit)) return null;
    return { kind: 'recent', period, limit: detail.limit, entryCount, failure };
  }
  if (detail.kind === 'sessionTimeseries') {
    if (!hasKeys(detail, ['kind', 'period', 'entryCount', 'failure'])) return null;
    return { kind: 'sessionTimeseries', period, entryCount, failure };
  }
  return null;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function hasKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
