import type { RuntimeHostDeliveryIssuer } from '../bootstrap';

const DECISION_TTL_MS = 30_000;
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
  port: number,
  fetcher: typeof fetch = fetch,
): DiagnosticsArchiveTransport {
  const url = `http://127.0.0.1:${port}/api/diagnostics/archive`;
  const downloadUrl = `${url}/download`;
  return {
    async archive(signal?: AbortSignal): Promise<DiagnosticsArchiveTransportResponse> {
      try {
        const response = await fetcher(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${issuer.signDecision({
              principal: 'electron-main-local',
              endpoint: '/api/diagnostics/archive',
              scope: 'diagnostics:write',
              capability: 'diagnostics.archive',
              subject: 'host-diagnostics',
              expiresAt: Date.now() + DECISION_TTL_MS,
              revision: '1',
            })}`,
            'Content-Type': 'application/json',
          },
          body: '{}',
          signal,
        });
        const body: unknown = await response.json();
        if (response.status === 200) {
          const receipt = decodeReceipt(body);
          if (receipt?.terminal === 'completed') return { status: 200, body: receipt };
        }
      } catch {
        // The public contract deliberately suppresses cancellation and transport details.
      }
      return { status: 503, body: UNAVAILABLE };
    },
    async download(archiveId: string, signal?: AbortSignal): Promise<DiagnosticsArchiveDownloadResponse> {
      if (!isArchiveId(archiveId)) return { status: 404, body: NOT_FOUND };
      try {
        const response = await fetcher(downloadUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${issuer.signDecision({
              principal: 'electron-main-local',
              endpoint: '/api/diagnostics/archive/download',
              scope: 'diagnostics:read',
              capability: 'diagnostics.archive.download',
              subject: 'host-diagnostics',
              expiresAt: Date.now() + DECISION_TTL_MS,
              revision: '1',
            })}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ archiveId }),
          signal,
        });
        if (response.status === 404) return { status: 404, body: NOT_FOUND };
        const body: unknown = await response.json();
        if (response.status === 200) {
          const data = decodeDownload(body, archiveId);
          if (data) return { status: 200, body: data };
        }
      } catch {
        // The public contract deliberately suppresses cancellation and transport details.
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

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
