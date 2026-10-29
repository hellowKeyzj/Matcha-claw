import { invokeIpc } from '@/lib/api-client';
import { hostApiFetchDecoded } from '@/lib/host-api';
import { waitForCall } from '@/lib/call-log-await';
import type { CallReceipt } from '@/types/call-log';
import { decodeDiagnosticsCallDetail } from '@/types/call-log/diagnostics';

export type DiagnosticsArchiveReceipt = Readonly<{
  archiveId: string;
  terminal: 'completed';
  entries: number;
  bytes: number;
}>;

export type DiagnosticsArchiveExportResult = Readonly<{
  status: 'saved' | 'cancelled' | 'failed';
}>;

const UNAVAILABLE_MESSAGE = 'Diagnostics archive is unavailable.';
const ARCHIVE_ID_PATTERN = /^[a-f0-9]{32}$/;

export async function collectDiagnosticsArchive(): Promise<DiagnosticsArchiveReceipt> {
  try {
    const admission = await hostApiFetchDecoded<CallReceipt>(
      '/api/diagnostics/archive',
      decodeAdmission,
      { method: 'POST', body: '{}', signal: undefined },
    );
    const call = await waitForCall(admission, 'diagnostics');
    if (call.module !== 'diagnostics' || call.command !== 'diagnostics.archive') {
      throw new Error(UNAVAILABLE_MESSAGE);
    }
    const detail = decodeDiagnosticsCallDetail(call.detail);
    if (!detail || detail.kind !== 'collectArchive' || detail.failure !== null || !detail.receipt) {
      throw new Error(UNAVAILABLE_MESSAGE);
    }
    return decodeReceipt(detail.receipt);
  } catch {
    throw new Error(UNAVAILABLE_MESSAGE);
  }
}

export async function exportDiagnosticsArchive(
  archiveId: string,
): Promise<DiagnosticsArchiveExportResult> {
  if (!ARCHIVE_ID_PATTERN.test(archiveId)) {
    throw new Error(UNAVAILABLE_MESSAGE);
  }
  try {
    const result = await invokeIpc<unknown>('diagnostics:exportArchive', { archiveId });
    if (!isRecord(result)
      || Object.keys(result).length !== 1
      || (result.status !== 'saved' && result.status !== 'cancelled' && result.status !== 'failed')) {
      throw new Error(UNAVAILABLE_MESSAGE);
    }
    return result as DiagnosticsArchiveExportResult;
  } catch {
    throw new Error(UNAVAILABLE_MESSAGE);
  }
}

function decodeAdmission(value: unknown): CallReceipt {
  if (!isRecord(value) || Object.keys(value).length !== 2
    || !ARCHIVE_ID_PATTERN.test(typeof value.callId === 'string' ? value.callId : '')
    || value.accepted !== true) throw new Error(UNAVAILABLE_MESSAGE);
  return { callId: value.callId as string, accepted: true };
}

function decodeReceipt(value: unknown): DiagnosticsArchiveReceipt {
  if (!isRecord(value)
    || Object.keys(value).length !== 4
    || !ARCHIVE_ID_PATTERN.test(typeof value.archiveId === 'string' ? value.archiveId : '')
    || value.terminal !== 'completed'
    || !isSafeNonNegativeInteger(value.entries)
    || !isSafeNonNegativeInteger(value.bytes)) {
    throw new Error(UNAVAILABLE_MESSAGE);
  }
  return {
    archiveId: value.archiveId as string,
    terminal: 'completed',
    entries: value.entries,
    bytes: value.bytes,
  };
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
