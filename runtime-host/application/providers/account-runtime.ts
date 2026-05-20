import { PROVIDER_VENDOR_DEFINITIONS } from './provider-registry';
import { validateApiKeyWithProvider } from './provider-validation';
import type { RuntimeClockPort, RuntimeHttpClientPort } from '../common/runtime-ports';
import {
  type CustomMediaApiProtocol,
  getCustomMediaContract,
  isCustomMediaApiProtocol,
} from './custom-media-provider-contracts';

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeHeadersRecord(input: unknown): Record<string, string> | undefined {
  if (!isRecord(input)) {
    return undefined;
  }

  const normalizedEntries: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(input)) {
    if (key.trim().length > 0 && typeof value === 'string' && value.trim().length > 0) {
      normalizedEntries.push([key, value.trim()]);
    }
  }
  const normalized = Object.fromEntries(normalizedEntries);

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeProviderKind(input: Record<string, any>, current: Record<string, any> | null | undefined): 'chat' | 'media' {
  const candidate = typeof input.providerKind === 'string'
    ? input.providerKind
    : (typeof current?.providerKind === 'string' ? current.providerKind : undefined);
  return candidate === 'media' ? 'media' : 'chat';
}

function normalizeMediaApiProtocol(input: unknown, current: unknown): CustomMediaApiProtocol | undefined {
  if (isCustomMediaApiProtocol(input)) return input;
  if (isCustomMediaApiProtocol(current)) return current;
  return undefined;
}

export function normalizeProviderAccountLocal(
  input: unknown,
  current: Record<string, any> | null | undefined,
  clock: RuntimeClockPort,
) {
  if (!isRecord(input)) {
    return null;
  }
  const id = typeof input.id === 'string' && input.id.trim()
    ? input.id.trim()
    : (typeof current?.id === 'string' ? current.id : '');
  const vendorId = typeof input.vendorId === 'string' && input.vendorId.trim()
    ? input.vendorId.trim()
    : (typeof current?.vendorId === 'string' ? current.vendorId : '');
  if (!id || !vendorId) {
    return null;
  }
  const providerKind = vendorId === 'custom' ? normalizeProviderKind(input, current) : 'chat';
  const mediaApiProtocol = providerKind === 'media'
    ? normalizeMediaApiProtocol(input.mediaApiProtocol, current?.mediaApiProtocol)
    : undefined;
  const mediaContract = getCustomMediaContract(mediaApiProtocol);
  if (providerKind === 'media' && (!mediaApiProtocol || !mediaContract)) {
    return null;
  }
  const nowIso = clock.nowIso();
  const headers = Object.prototype.hasOwnProperty.call(input, 'headers')
    ? normalizeHeadersRecord(input.headers)
    : normalizeHeadersRecord(current?.headers);
  const metadata = isRecord(input.metadata)
    ? input.metadata
    : (isRecord(current?.metadata) ? current.metadata : undefined);
  return {
    id,
    vendorId,
    providerKind,
    label: typeof input.label === 'string'
      ? input.label
      : (typeof current?.label === 'string' ? current.label : vendorId),
    authMode: typeof input.authMode === 'string'
      ? input.authMode
      : (typeof current?.authMode === 'string' ? current.authMode : 'api_key'),
    enabled: typeof input.enabled === 'boolean'
      ? input.enabled
      : (typeof current?.enabled === 'boolean' ? current.enabled : true),
    baseUrl: typeof input.baseUrl === 'string'
      ? input.baseUrl
      : (typeof current?.baseUrl === 'string' ? current.baseUrl : undefined),
    apiProtocol: providerKind === 'chat' && typeof input.apiProtocol === 'string'
      ? input.apiProtocol
      : (providerKind === 'chat' && typeof current?.apiProtocol === 'string' ? current.apiProtocol : undefined),
    mediaApiProtocol,
    headers,
    ...(metadata ? { metadata } : {}),
    createdAt: typeof current?.createdAt === 'string' ? current.createdAt : nowIso,
    updatedAt: nowIso,
  };
}

function maskProviderApiKeyLocal(value: unknown) {
  if (typeof value !== 'string' || !value) {
    return null;
  }
  if (value.length <= 8) {
    return '*'.repeat(value.length);
  }
  return `${value.slice(0, 4)}${'*'.repeat(Math.max(value.length - 8, 1))}${value.slice(-4)}`;
}

export function accountToStatusLocal(account: Record<string, any>, apiKey: string | undefined) {
  return {
    id: account.id,
    name: account.label,
    type: account.vendorId,
    baseUrl: account.baseUrl,
    enabled: account.enabled !== false,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    hasKey: typeof apiKey === 'string' && apiKey.trim().length > 0,
    keyMasked: maskProviderApiKeyLocal(apiKey),
  };
}

export function sortProviderAccountsLocal(accounts: any[]) {
  return [...accounts].sort((left, right) => {
    const byUpdatedAt = String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''));
    if (byUpdatedAt !== 0) {
      return byUpdatedAt;
    }
    return String(left.id).localeCompare(String(right.id));
  });
}

function getVendorDefinitionLocal(vendorId: string) {
  return PROVIDER_VENDOR_DEFINITIONS.find((item) => item.id === vendorId);
}

function isProviderProtocol(value: unknown): value is 'openai-completions' | 'openai-responses' | 'anthropic-messages' {
  return value === 'openai-completions' || value === 'openai-responses' || value === 'anthropic-messages';
}

function getVendorDefaultBaseUrl(vendorId: string): string | undefined {
  const vendor = getVendorDefinitionLocal(vendorId);
  return typeof vendor?.defaultBaseUrl === 'string' ? vendor.defaultBaseUrl : undefined;
}

export async function validateProviderApiKeyLocal(input: unknown, httpClient: RuntimeHttpClientPort) {
  if (!isRecord(input)) {
    return { valid: false, error: 'Invalid provider validate payload' };
  }
  const vendorId = typeof input.vendorId === 'string' ? input.vendorId : '';
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  const options = isRecord(input.options) ? input.options : {};
  const baseUrl = typeof options.baseUrl === 'string' && options.baseUrl.trim().length > 0
    ? options.baseUrl.trim()
    : getVendorDefaultBaseUrl(vendorId);
  const apiProtocol = isProviderProtocol(options.apiProtocol)
    ? options.apiProtocol
    : undefined;
  const headers = normalizeHeadersRecord(options.headers);
  const vendor = getVendorDefinitionLocal(vendorId);
  if (!vendor) {
    return { valid: false, error: `Unsupported provider vendor: ${vendorId}` };
  }
  if (vendor.requiresApiKey && !apiKey) {
    return { valid: false, error: 'API key is required' };
  }
  if (!apiKey) {
    return { valid: true };
  }

  return await validateApiKeyWithProvider(vendorId, apiKey, {
    httpClient,
    baseUrl,
    apiProtocol,
    ...(headers ? { headers } : {}),
  });
}
