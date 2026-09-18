import type { RuntimeHostDeliveryIssuer } from '../issuer';
import {
  hasExactKeys,
  isRecord,
  isSafeNonNegativeInteger,
  sendLoopbackJson,
} from './client';

const UNAVAILABLE = {
  success: false,
  error: 'Diagnostics archive is unavailable',
} as const;
const NOT_FOUND = {
  success: false,
  error: 'Diagnostics archive was not found',
} as const;
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024;

type DiagnosticsArchiveTerminal = 'completed' | 'cancelled' | 'failed';

export type DiagnosticsArchiveReceipt = Readonly<{
  archiveId: string;
  terminal: DiagnosticsArchiveTerminal;
  entries: number;
  bytes: number;
}>;

export type DiagnosticsArchiveTransportResponse = Readonly<{
  status: 200 | 503;
  body: DiagnosticsArchiveReceipt | typeof UNAVAILABLE;
}>;

export type DiagnosticsArchiveDownloadResponse = Readonly<{
  status: 200 | 404 | 503;
  body: Uint8Array | typeof NOT_FOUND | typeof UNAVAILABLE;
}>;

export interface DiagnosticsArchiveTransport {
  archive(signal?: AbortSignal): Promise<DiagnosticsArchiveTransportResponse>;
  download(archiveId: string, signal?: AbortSignal): Promise<DiagnosticsArchiveDownloadResponse>;
}

export function createDiagnosticsArchiveTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): DiagnosticsArchiveTransport {
  return {
    async archive(signal?: AbortSignal): Promise<DiagnosticsArchiveTransportResponse> {
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        path: '/api/diagnostics/archive',
        issuer,
        decision: {
          endpoint: '/api/diagnostics/archive',
          scope: 'diagnostics:write',
          capability: 'diagnostics.archive',
          subject: 'host-diagnostics',
        },
        method: 'POST',
        fetcher,
        body: {},
        signal,
      });
      if (response?.status === 200) {
        const receipt = decodeReceipt(response.body);
        if (receipt?.terminal === 'completed') return { status: 200, body: receipt };
      }
      return { status: 503, body: UNAVAILABLE };
    },
    async download(archiveId: string, signal?: AbortSignal): Promise<DiagnosticsArchiveDownloadResponse> {
      if (!isArchiveId(archiveId)) return { status: 404, body: NOT_FOUND };
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        path: '/api/diagnostics/archive/download',
        issuer,
        decision: {
          endpoint: '/api/diagnostics/archive/download',
          scope: 'diagnostics:read',
          capability: 'diagnostics.archive.download',
          subject: 'host-diagnostics',
        },
        method: 'POST',
        fetcher,
        body: { archiveId },
        signal,
      });
      if (response?.status === 404) return { status: 404, body: NOT_FOUND };
      if (response?.status === 200) {
        const data = decodeDownload(response.body, archiveId);
        if (data) return { status: 200, body: data };
      }
      return { status: 503, body: UNAVAILABLE };
    },
  };
}

function decodeReceipt(value: unknown): DiagnosticsArchiveReceipt | null {
  if (!isRecord(value) || !hasExactKeys(value, ['archiveId', 'terminal', 'entries', 'bytes'])) {
    return null;
  }
  if (!isArchiveId(value.archiveId)
    || (value.terminal !== 'completed' && value.terminal !== 'cancelled' && value.terminal !== 'failed')
    || !isSafeNonNegativeInteger(value.entries)
    || !isSafeNonNegativeInteger(value.bytes)) {
    return null;
  }
  return {
    archiveId: value.archiveId,
    terminal: value.terminal,
    entries: value.entries,
    bytes: value.bytes,
  };
}

function decodeDownload(value: unknown, archiveId: string): Uint8Array | null {
  if (!isRecord(value) || !hasExactKeys(value, ['archiveId', 'data']) || value.archiveId !== archiveId
    || typeof value.data !== 'string') {
    return null;
  }
  const decodedBytes = canonicalBase64DecodedBytes(value.data);
  if (decodedBytes === null || decodedBytes > MAX_DOWNLOAD_BYTES) return null;
  const data = Buffer.from(value.data, 'base64');
  return data.length === decodedBytes && data[0] === 0x50 && data[1] === 0x4b ? data : null;
}

function canonicalBase64DecodedBytes(value: string): number | null {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const terminal = value.charCodeAt(value.length - padding - 1);
  if ((padding === 1 && base64Value(terminal) % 4 !== 0)
    || (padding === 2 && base64Value(terminal) % 16 !== 0)) return null;
  return (value.length / 4) * 3 - padding;
}

function base64Value(codePoint: number): number {
  if (codePoint >= 65 && codePoint <= 90) return codePoint - 65;
  if (codePoint >= 97 && codePoint <= 122) return codePoint - 97 + 26;
  if (codePoint >= 48 && codePoint <= 57) return codePoint - 48 + 52;
  return codePoint === 43 ? 62 : 63;
}

function isArchiveId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
}
