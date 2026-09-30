import type { CronJob } from './cron';

export type CronResultCommand = 'create' | 'update' | 'delete';
export type CronResultRequest =
  | { callId: string; command: 'create' }
  | { callId: string; command: 'update' | 'delete'; jobId: string };
export type CronDeleteResult = { removed: boolean };

export function isCronResultRequest(value: unknown): value is CronResultRequest {
  return isRecord(value)
    && typeof value.callId === 'string' && /^[a-f0-9]{32}$/.test(value.callId)
    && (value.command === 'create'
      ? hasExactKeys(value, ['callId', 'command'])
      : (value.command === 'update' || value.command === 'delete')
        && hasExactKeys(value, ['callId', 'command', 'jobId']) && isNonEmptyString(value.jobId));
}

export function isCronDeleteResult(value: unknown): value is CronDeleteResult {
  return isRecord(value) && hasExactKeys(value, ['removed']) && typeof value.removed === 'boolean';
}

export function isCronJob(value: unknown): value is CronJob {
  return isRecord(value)
    && hasAllowedKeys(value, [
      'id', 'name', 'agentId', 'message', 'model', 'schedule', 'delivery', 'target', 'enabled',
      'createdAt', 'updatedAt', 'lastRun', 'nextRun', 'runningAt',
    ], [
      'id', 'name', 'agentId', 'message', 'schedule', 'delivery', 'enabled', 'createdAt', 'updatedAt',
    ])
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.name)
    && isNonEmptyString(value.agentId)
    && typeof value.message === 'string'
    && (value.model === undefined || isNonEmptyString(value.model))
    && isSchedule(value.schedule)
    && isDelivery(value.delivery)
    && (value.target === undefined || isTargetProjection(value.target))
    && typeof value.enabled === 'boolean'
    && isIsoTimestamp(value.createdAt)
    && isIsoTimestamp(value.updatedAt)
    && (value.lastRun === undefined || isLastRun(value.lastRun))
    && (value.nextRun === undefined || isIsoTimestamp(value.nextRun))
    && (value.runningAt === undefined || isIsoTimestamp(value.runningAt));
}

function isSchedule(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'at') return hasExactKeys(value, ['kind', 'at']) && isNonEmptyString(value.at);
  if (value.kind === 'every') return hasAllowedKeys(value, ['kind', 'everyMs', 'anchorMs'], ['kind', 'everyMs'])
    && isTimestamp(value.everyMs) && (value.anchorMs === undefined || isTimestamp(value.anchorMs));
  return value.kind === 'cron'
    && hasAllowedKeys(value, ['kind', 'expr', 'tz'], ['kind', 'expr'])
    && isNonEmptyString(value.expr)
    && (value.tz === undefined || isNonEmptyString(value.tz));
}

function isDelivery(value: unknown): boolean {
  if (!isRecord(value) || typeof value.mode !== 'string') return false;
  if (value.mode === 'none') return hasExactKeys(value, ['mode']);
  return value.mode === 'announce'
    && hasAllowedKeys(value, ['mode', 'channel', 'to', 'accountId'], ['mode', 'channel'])
    && isNonEmptyString(value.channel)
    && (value.to === undefined || isNonEmptyString(value.to))
    && (value.accountId === undefined || isNonEmptyString(value.accountId));
}

function isTargetProjection(value: unknown): boolean {
  return isRecord(value)
    && hasAllowedKeys(value, ['channelType', 'channelId', 'channelName', 'recipient'], ['channelType', 'channelId', 'channelName'])
    && isNonEmptyString(value.channelType)
    && isNonEmptyString(value.channelId)
    && isNonEmptyString(value.channelName)
    && (value.recipient === undefined || isNonEmptyString(value.recipient));
}

function isLastRun(value: unknown): boolean {
  return isRecord(value)
    && hasAllowedKeys(value, ['time', 'success', 'error', 'duration'], ['time', 'success'])
    && isIsoTimestamp(value.time)
    && typeof value.success === 'boolean'
    && (value.error === undefined || typeof value.error === 'string')
    && (value.duration === undefined || isTimestamp(value.duration));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0');
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return false;
  }
  const timestamp = Date.parse(value);
  return !Number.isNaN(timestamp) && new Date(timestamp).toISOString() === value;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function hasAllowedKeys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key)) && required.every((key) => Object.hasOwn(value, key));
}
