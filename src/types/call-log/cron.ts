export interface CronCallDetail {
  jobId?: string;
  runId?: string;
  scheduleKind?: 'cron' | 'at' | 'every';
  enabled?: boolean;
  historyLimit?: number;
  itemCount?: number;
  removed?: boolean;
  outcome?: 'applied' | 'listed' | 'loaded' | 'accepted' | 'skipped' | 'rejected'
    | 'unavailable' | 'protocol' | 'deadline' | 'outcome-unknown';
  skipReason?: 'already-running' | 'not-due' | 'invalid-spec' | 'disabled' | 'stopped';
  executionStatus?: 'waiting' | 'succeeded' | 'failed' | 'skipped' | 'cancelled' | 'outcome-unknown';
}

declare module '../call-log' {
  interface CallDetailByModule {
    cron: CronCallDetail;
  }
}

export function decodeCronCallDetail(value: unknown): CronCallDetail | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  for (const [key, field] of Object.entries(value)) {
    switch (key) {
      case 'jobId':
      case 'runId':
        if (typeof field !== 'string' || field.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(field)) return null;
        break;
      case 'enabled':
      case 'removed':
        if (typeof field !== 'boolean') return null;
        break;
      case 'historyLimit':
      case 'itemCount':
        if (typeof field !== 'number' || !Number.isSafeInteger(field) || field < 0) return null;
        break;
      case 'scheduleKind':
        if (field !== 'cron' && field !== 'at' && field !== 'every') return null;
        break;
      case 'outcome':
        if (typeof field !== 'string' || !['applied', 'listed', 'loaded', 'accepted', 'skipped', 'rejected', 'unavailable', 'protocol', 'deadline', 'outcome-unknown'].includes(field)) return null;
        break;
      case 'skipReason':
        if (typeof field !== 'string' || !['already-running', 'not-due', 'invalid-spec', 'disabled', 'stopped'].includes(field)) return null;
        break;
      case 'executionStatus':
        if (typeof field !== 'string' || !['waiting', 'succeeded', 'failed', 'skipped', 'cancelled', 'outcome-unknown'].includes(field)) return null;
        break;
      default:
        return null;
    }
  }
  return value as CronCallDetail;
}
