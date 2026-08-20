import type { RuntimeHostDeliveryIssuer } from '../../bootstrap';

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
  form(channel: string): Promise<ChannelConfigureTransportResponse>;
  apply(input: ChannelConfigureInput): Promise<ChannelConfigureTransportResponse>;
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
    async form(channel): Promise<ChannelConfigureTransportResponse> {
      if (!isIdentity(channel)) return { status: 503, body: UNAVAILABLE };
      return await requestConfigure(
        issuer,
        configureUrl,
        fetcher,
        { action: 'form', channel },
        isChannelConfigureForm,
      );
    },
    async apply(input): Promise<ChannelConfigureTransportResponse> {
      if (!isIdentity(input.channel) || !isIdentity(input.accountId) || !isValuesObject(input.values)) {
        return { status: 503, body: UNAVAILABLE };
      }
      return await requestConfigure(
        issuer,
        configureUrl,
        fetcher,
        { action: 'apply', ...input },
        isChannelConfigureOutcome,
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
): Promise<ChannelConfigureTransportResponse> {
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
      },
      body: JSON.stringify(body),
    });
    const responseBody: unknown = await response.json();
    if (response.status === 400 && isRejected(responseBody)) {
      return { status: 400, body: responseBody };
    }
    if (response.status === 200 && isExpectedBody(responseBody)) {
      return { status: 200, body: responseBody };
    }
    if (response.status === 503 && isUnknown(responseBody)) {
      return { status: 503, body: responseBody };
    }
  } catch {
    // Native errors and configuration values, including secrets, stay private.
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
