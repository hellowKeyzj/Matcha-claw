import type { CallRecord } from '@/types/call-log';

export interface CallField {
  path: string[];
  value: unknown;
}

export function callFields(detail: CallRecord['detail']): CallField[] {
  const fields: CallField[] = [];
  const visit = (value: unknown, path: string[]) => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [key, item] of Object.entries(value)) visit(item, [...path, key]);
    } else if (value !== null && value !== undefined && (!Array.isArray(value) || value.length > 0)) {
      fields.push({ path, value });
    }
  };
  visit(detail, []);
  return fields;
}

export function isTechnicalField({ path }: CallField): boolean {
  const key = path[path.length - 1];
  return /(?:Id|Ref|Key|Revision|Sha256)$/.test(key)
    || ['kind', 'operation', 'phase', 'seq', 'revision', 'sha256', 'version', 'offset', 'privateResolverCode', 'command', 'endpoint'].includes(key);
}

export function changedCallFields(previous: CallRecord['detail'] | undefined, current: CallRecord['detail']): CallField[] {
  if (!previous) return [];
  const before = new Map(callFields(previous).map((field) => [field.path.join('.'), field]));
  const after = new Map(callFields(current).map((field) => [field.path.join('.'), field]));
  return [...new Set([...before.keys(), ...after.keys()])].flatMap((key) => {
    const old = before.get(key);
    const next = after.get(key);
    if (JSON.stringify(old?.value) === JSON.stringify(next?.value)) return [];
    return [next ?? { path: old!.path, value: null }];
  });
}

export function callDuration(call: Pick<CallRecord, 'start' | 'end'>, language: string): string | null {
  if (call.end === null) return null;
  const milliseconds = call.end - call.start;
  const unit = milliseconds < 1_000 ? 'millisecond' : milliseconds < 60_000 ? 'second' : 'minute';
  const value = unit === 'millisecond' ? milliseconds : unit === 'second' ? milliseconds / 1_000 : milliseconds / 60_000;
  return new Intl.NumberFormat(language, { style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: 1 }).format(value);
}
