import type { SessionPage } from '../main/sessions/observations';

export type HostApiRequest = Readonly<{
  method: string;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  signal: AbortSignal;
  sessionPage?: SessionPage;
  readBytes(maximum?: number, drainOnError?: boolean): Promise<Uint8Array>;
  readJson<T>(): Promise<T>;
}>;

export class HostApiBodyTooLarge extends Error {
  constructor() {
    super('Host API request body is too large.');
  }
}

export type HostApiResponse = Readonly<{
  kind: 'json';
  status: number;
  serializedBody: string | undefined;
  headers?: Readonly<Record<string, string>>;
}> | Readonly<{
  kind: 'bytes';
  status: number;
  body: Uint8Array;
  contentType: string;
}>;

// undefined means unmatched; null means the matched request stopped observing.
export type HostApiRouteResult = HostApiResponse | null | undefined;
export type HostApiDispatcher = (request: HostApiRequest, url: URL) => Promise<HostApiResponse | null>;

export function jsonResult(status: number, payload: unknown, headers?: Readonly<Record<string, string>>): HostApiResponse {
  return { kind: 'json', status, serializedBody: JSON.stringify(payload), ...(headers ? { headers } : {}) };
}

export function parseJsonText<T>(text: string): T {
  const raw = text.trim();
  return (raw ? JSON.parse(raw) : {}) as T;
}

export function parseJsonBytes<T>(bytes: Uint8Array): T {
  return parseJsonText<T>(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8'));
}
