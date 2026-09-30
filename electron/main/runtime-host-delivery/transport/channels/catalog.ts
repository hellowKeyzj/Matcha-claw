import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { isRecord, sendLoopbackJson } from '../client';
import { beginChannelTrace, channelTraceError, channelTraceHeaders } from './trace';

const CATALOG_ENDPOINT = '/api/channels/catalog';
const CONFIGURE_ENDPOINT = '/api/channels/configure';
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
type ChannelCallReceipt = Readonly<{ callId: string; accepted: true }>;

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
  status: 200 | 202 | 400 | 503;
  body: ChannelConfigureForm | ChannelConfigureOutcome | ChannelCallReceipt | typeof REJECTED | typeof UNAVAILABLE;
}>;

export interface ChannelCatalogTransport {
  read(): Promise<ChannelCatalogTransportResponse>;
  form(channel: string, traceId?: string): Promise<ChannelConfigureTransportResponse>;
  apply(input: ChannelConfigureInput, traceId?: string): Promise<ChannelConfigureTransportResponse>;
}

export function createChannelCatalogTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): ChannelCatalogTransport {
  return {
    async read(): Promise<ChannelCatalogTransportResponse> {
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        path: CATALOG_ENDPOINT,
        issuer,
        decision: {
          endpoint: CATALOG_ENDPOINT,
          scope: 'channels:read',
          capability: 'channels.catalog.read',
          subject: 'channel-catalog',
        },
        method: 'POST',
        fetcher,
        body: {},
      });
      if (response?.status === 200 && isChannelCatalog(response.body)) {
        return { status: 200, body: response.body };
      }
      return { status: 503, body: UNAVAILABLE };
    },
    async form(channel, traceId): Promise<ChannelConfigureTransportResponse> {
      if (!isIdentity(channel)) return { status: 503, body: UNAVAILABLE };
      return await requestConfigure(
        issuer,
        runtimeHostTransportPort,
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
        runtimeHostTransportPort,
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
  runtimeHostTransportPort: number,
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
    const response = await sendLoopbackJson({
      port: runtimeHostTransportPort,
      path: CONFIGURE_ENDPOINT,
      issuer,
      decision: {
        endpoint: CONFIGURE_ENDPOINT,
        scope: 'channels:write',
        capability: 'channels.configure',
        subject: 'channel-configure',
      },
      method: 'POST',
      fetcher,
      body,
      headers: channelTraceHeaders(traceId),
    });
    status = response?.status ?? 503;
    outcome = response?.body ?? UNAVAILABLE;
    if (phase === 'transport.configure.apply' && response?.status === 202 && isCallReceipt(response.body)) {
      return { status: 202, body: response.body };
    }
    if (response?.status === 400 && isRejected(response.body)) {
      return { status: 400, body: response.body };
    }
    if (response?.status === 200 && isExpectedBody(response.body)) {
      return { status: 200, body: response.body };
    }
    if (response?.status === 503 && isUnknown(response.body)) {
      return { status: 503, body: response.body };
    }
    outcome = UNAVAILABLE;
    errorCode = response === null ? 'UNAVAILABLE' : 'INVALID_RESPONSE';
  } catch (error) {
    outcome = UNAVAILABLE;
    errorCode = channelTraceError(error);
  } finally {
    finish(status, outcome, errorCode);
  }
  return { status: 503, body: UNAVAILABLE };
}

function isCallReceipt(value: unknown): value is ChannelCallReceipt {
  return isRecord(value) && Object.keys(value).length === 2
    && value.accepted === true && typeof value.callId === 'string' && /^[0-9a-f]{32}$/.test(value.callId);
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

function isChannelConfigureOutcome(value: unknown): value is ChannelConfigureOutcome {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return Object.keys(body).length === 1
    && (body.outcome === 'confirmed' || body.outcome === 'target_rejected' || body.outcome === 'unknown');
}
