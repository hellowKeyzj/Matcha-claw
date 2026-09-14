import type { RuntimeHostDeliveryIssuer } from '../../bootstrap';
import { SESSION_TRACE_HEADER } from '../sessions/trace';

const DECISION_TTL_MS = 30_000;
const UNAVAILABLE = { outcome: 'unknown' } as const;
type Rejected = Readonly<{ outcome: 'rejected' }>;
const REJECTED: Rejected = { outcome: 'rejected' };
void REJECTED;

type ChannelCatalogEntry = Readonly<{
  id: string;
  label: string;
  detailLabel?: string;
  systemImage?: string;
  configured: boolean;
}>;

type ChannelConfigureFieldKind = 'text' | 'password' | 'boolean' | 'number' | 'select';
type ChannelConfigureField = Readonly<{
  key: string;
  label: string;
  description?: string;
  kind: ChannelConfigureFieldKind;
  required: boolean;
  options?: readonly string[];
}>;
type ChannelConfigureForm = Readonly<{ fields: readonly ChannelConfigureField[] }>;
type ChannelConfigureOutcome = Readonly<{
  outcome: 'confirmed' | 'target_rejected' | 'unknown';
}>;

type ChannelConfigureInput = Readonly<{
  channel: string;
  accountId: string;
  agentId?: string;
  values: Record<string, unknown>;
}>;

export type ChannelCatalogTransportResponse = Readonly<{
  status: 200 | 503;
  body: Readonly<{ entries: readonly ChannelCatalogEntry[] }> | typeof UNAVAILABLE;
}>;

export type ChannelConfigureTransportResponse = Readonly<{
  status: 200 | 400 | 503;
  body: ChannelConfigureForm | ChannelConfigureOutcome | typeof REJECTED | typeof UNAVAILABLE;
}>;

export interface ChannelCatalogTransport {
  read(): Promise<ChannelCatalogTransportResponse>;
  form(channel: string, traceId?: string): Promise<ChannelConfigureTransportResponse>;
  apply(input: ChannelConfigureInput, traceId?: string): Promise<ChannelConfigureTransportResponse>;
}

export function createChannelCatalogTransport(
  issuer: RuntimeHostDeliveryIssuer,
  port: number,
  fetcher: typeof fetch = fetch,
): ChannelCatalogTransport {
  const catalogUrl = `http://127.0.0.1:${port}/api/channels/catalog`;
  const configureUrl = `http://127.0.0.1:${port}/api/channels/configure`;
  return {
    async read(): Promise<ChannelCatalogTransportResponse> {
      try {
        const response = await fetcher(catalogUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${issuer.signDecision({
              principal: 'electron-main-local',
              endpoint: '/api/channels/catalog',
              scope: 'channels:read',
              capability: 'channels.catalog.read',
              subject: 'channel-catalog',
              expiresAt: Date.now() + DECISION_TTL_MS,
              revision: '1',
            })}`,
            'Content-Type': 'application/json',
          },
          body: '{}',
        });
        const body: unknown = await response.json();
        if (response.status === 200 && isChannelCatalog(body)) {
          return { status: 200, body };
        }
      } catch {
        // Native transport details do not cross the Electron delivery boundary.
      }
      return { status: 503, body: UNAVAILABLE };
    },
    async form(channel, traceId): Promise<ChannelConfigureTransportResponse> {
      if (!isIdentity(channel)) return { status: 503, body: UNAVAILABLE };
      return await requestConfigure(
        issuer,
        configureUrl,
        fetcher,
        { action: 'form', channel },
        isChannelConfigureForm,
        'transport.configure.form',
        traceId,
      );
    },
    async apply(input, traceId): Promise<ChannelConfigureTransportResponse> {
      if (!isIdentity(input.channel)
        || !isIdentity(input.accountId)
        || (input.agentId !== undefined && !isIdentity(input.agentId))
        || !isValuesObject(input.values)) {
        return { status: 503, body: UNAVAILABLE };
      }
      return await requestConfigure(
        issuer,
        configureUrl,
        fetcher,
        { action: 'apply', ...input },
        isChannelConfigureOutcome,
        'transport.configure.apply',
        traceId,
      );
    },
  };
}

async function requestConfigure<T extends ChannelConfigureForm | ChannelConfigureOutcome>(
  issuer: RuntimeHostDeliveryIssuer,
  url: string,
  fetcher: typeof fetch,
  body: unknown,
  isExpectedBody: (value: unknown) => value is T,
  phase: 'transport.configure.form' | 'transport.configure.apply',
  traceId?: string,
): Promise<ChannelConfigureTransportResponse> {
  const finish = beginChannelTrace(phase, traceId);
  let status = 503;
  let outcome: unknown;
  let errorCode: ReturnType<typeof channelTraceError> | 'INVALID_RESPONSE' | undefined;
  try {
    const response = await fetcher(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${issuer.signDecision({
          principal: 'electron-main-local',
          endpoint: '/api/channels/configure',
          scope: 'channels:write',
          capability: 'channels.configure',
          subject: 'channel-configure',
          expiresAt: Date.now() + DECISION_TTL_MS,
          revision: '1',
        })}`,
        'Content-Type': 'application/json',
        ...channelTraceHeaders(traceId),
      },
      body: JSON.stringify(body),
    });
    status = response.status;
    const responseBody: unknown = await response.json();
    outcome = responseBody;
    if (response.status === 400 && isRejected(responseBody)) {
      return { status: 400, body: responseBody };
    }
    if (response.status === 200 && isExpectedBody(responseBody)) {
      return { status: 200, body: responseBody };
    }
    if (response.status === 503 && isUnknown(responseBody)) {
      return { status: 503, body: responseBody };
    }
    outcome = UNAVAILABLE;
    errorCode = 'INVALID_RESPONSE';
  } catch (error) {
    outcome = UNAVAILABLE;
    errorCode = channelTraceError(error);
  } finally {
    finish(status, outcome, errorCode);
  }
  return { status: 503, body: UNAVAILABLE };
}

function isIdentity(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 128
    && !/\s/.test(value);
}

function isValuesObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isChannelCatalog(value: unknown): value is Readonly<{ entries: readonly ChannelCatalogEntry[] }> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return Object.keys(body).length === 1
    && Array.isArray(body.entries)
    && body.entries.every(isChannelCatalogEntry);
}

function isChannelCatalogEntry(value: unknown): value is ChannelCatalogEntry {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (Object.keys(entry).length === 3
      || Object.keys(entry).length === 4
      || Object.keys(entry).length === 5)
    && typeof entry.id === 'string'
    && entry.id.length > 0
    && typeof entry.label === 'string'
    && entry.label.length > 0
    && typeof entry.configured === 'boolean'
    && (entry.detailLabel === undefined || typeof entry.detailLabel === 'string')
    && (entry.systemImage === undefined || typeof entry.systemImage === 'string');
}

function isChannelConfigureForm(value: unknown): value is ChannelConfigureForm {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return Object.keys(body).length === 1
    && Array.isArray(body.fields)
    && body.fields.every(isChannelConfigureField);
}

function isChannelConfigureField(value: unknown): value is ChannelConfigureField {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const field = value as Record<string, unknown>;
  const keys = Object.keys(field);
  return keys.length >= 4
    && keys.length <= 6
    && keys.every((key) => ['key', 'label', 'description', 'kind', 'required', 'options'].includes(key))
    && isIdentity(field.key)
    && typeof field.label === 'string'
    && field.label.length > 0
    && (field.description === undefined || typeof field.description === 'string')
    && isChannelConfigureFieldKind(field.kind)
    && typeof field.required === 'boolean'
    && (field.options === undefined
      || (Array.isArray(field.options) && field.options.every((option) => typeof option === 'string')));
}

function isChannelConfigureFieldKind(value: unknown): value is ChannelConfigureFieldKind {
  return value === 'text'
    || value === 'password'
    || value === 'boolean'
    || value === 'number'
    || value === 'select';
}

function isRejected(value: unknown): value is typeof REJECTED {
  return isRecord(value) && Object.keys(value).length === 1 && value.outcome === 'rejected';
}

function isUnknown(value: unknown): value is typeof UNAVAILABLE {
  return isRecord(value) && Object.keys(value).length === 1 && value.outcome === 'unknown';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isChannelConfigureOutcome(value: unknown): value is ChannelConfigureOutcome {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return Object.keys(body).length === 1
    && (body.outcome === 'confirmed' || body.outcome === 'target_rejected' || body.outcome === 'unknown');
}


const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readChannelTrace(headers: Record<string, string | string[] | undefined>): string | undefined {
  const value = headers[SESSION_TRACE_HEADER.toLowerCase()] ?? headers[SESSION_TRACE_HEADER];
  return typeof value === 'string' && UUID.test(value) ? value : undefined;
}

export function channelTraceHeaders(traceId: string | undefined): Record<string, string> {
  return traceId && UUID.test(traceId) ? { [SESSION_TRACE_HEADER]: traceId } : {};
}

export function beginChannelTrace(phase: string, traceId: string | undefined) {
  const startedAt = performance.now();
  const write = (suffix: 'start' | 'end', detail: object) => {
    if (!traceId || !UUID.test(traceId)) return;
    console.info(`[startup-trace] ${JSON.stringify({ source: 'electron-main', traceId, phase: `${phase}.${suffix}`, at: Date.now(), ...detail })}`);
  };
  write('start', {});
  return (status: number, body: unknown, errorCode?: 'UNAVAILABLE' | 'ABORTED' | 'TIMEOUT' | 'INVALID_RESPONSE') => {
    const value = body !== null && typeof body === 'object' && 'outcome' in body ? body.outcome : undefined;
    const valid = body !== null && typeof body === 'object' && 'valid' in body ? body.valid : undefined;
    const outcome = typeof value === 'string' && ['confirmed', 'connected', 'progress', 'target_rejected', 'unknown', 'rejected', 'cancelled'].includes(value)
      ? value : typeof valid === 'boolean' ? valid ? 'valid' : 'invalid' : status === 200 ? 'delivered' : 'unknown';
    write('end', { durationMs: Math.round(performance.now() - startedAt), status, outcome, ...(errorCode ? { errorCode } : {}) });
  };
}

export function channelTraceError(error: unknown): 'UNAVAILABLE' | 'ABORTED' | 'TIMEOUT' {
  if (error instanceof Error && error.name === 'AbortError') return 'ABORTED';
  if (error instanceof Error && error.name === 'TimeoutError') return 'TIMEOUT';
  return 'UNAVAILABLE';
}
