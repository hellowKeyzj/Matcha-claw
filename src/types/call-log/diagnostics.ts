export type DiagnosticsCallFailure = 'ownerUnavailable' | 'invalidRoot' | 'outputUnavailable'
  | 'archiveNotFound' | 'archiveIdUnavailable';

export interface DiagnosticsArchiveCallReceipt {
  archiveId: string;
  terminal: 'completed' | 'cancelled' | 'failed';
  entries: number;
  bytes: number;
}

export type DiagnosticsCallDetail =
  | { kind: 'collectArchive'; receipt: DiagnosticsArchiveCallReceipt | null; failure: DiagnosticsCallFailure | null }
  | { kind: 'downloadArchive'; archiveId: string | null; bytes: number | null; failure: DiagnosticsCallFailure | null };

declare module '../call-log' {
  interface CallDetailByModule {
    diagnostics: DiagnosticsCallDetail;
  }
}

export function decodeDiagnosticsCallDetail(value: unknown): DiagnosticsCallDetail | null {
  if (!isRecord(value) || !isFailure(value.failure)) return null;
  if (value.kind === 'collectArchive') {
    if (!exact(value, ['kind', 'receipt', 'failure'])
      || (value.receipt !== null && !isReceipt(value.receipt))) return null;
  } else if (value.kind === 'downloadArchive') {
    if (!exact(value, ['kind', 'archiveId', 'bytes', 'failure'])
      || !(value.archiveId === null || isArchiveId(value.archiveId))
      || !(value.bytes === null || isCount(value.bytes))) return null;
  } else {
    return null;
  }
  return value as DiagnosticsCallDetail;
}

function isReceipt(value: unknown): value is DiagnosticsArchiveCallReceipt {
  if (!isRecord(value) || !exact(value, ['archiveId', 'terminal', 'entries', 'bytes'])
    || !isCount(value.entries) || !isCount(value.bytes)
    || !['completed', 'cancelled', 'failed'].includes(value.terminal as string)) return false;
  if (value.terminal !== 'completed' && (value.entries !== 0 || value.bytes !== 0)) return false;
  return isArchiveId(value.archiveId)
    || (value.archiveId === 'unavailable' && value.terminal === 'failed');
}

function isFailure(value: unknown): value is DiagnosticsCallFailure | null {
  return value === null || (typeof value === 'string'
    && ['ownerUnavailable', 'invalidRoot', 'outputUnavailable', 'archiveNotFound', 'archiveIdUnavailable'].includes(value));
}

function isArchiveId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
