import { PROVIDER_VENDOR_DEFINITIONS } from './provider-registry';
import { validateApiKeyWithProvider } from './provider-validation';

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeHeadersRecord(input: unknown): Record<string, string> | undefined {
  if (!isRecord(input)) {
    return undefined;
  }

  const normalized = Object.fromEntries(
    Object.entries(input)
      .filter(
        ([key, value]): value is string =>
          typeof key === 'string'
          && key.trim().length > 0
          && typeof value === 'string'
          && value.trim().length > 0,
      )
      .map(([key, value]) => [key, value.trim()]),
  );

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function normalizeProviderAccountLocal(input: unknown, current?: Record<string, any> | null) {
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
  const nowIso = new Date().toISOString();
  const headers = Object.prototype.hasOwnProperty.call(input, 'headers')
    ? normalizeHeadersRecord(input.headers)
    : normalizeHeadersRecord(current?.headers);
  return {
    ...current,
    ...input,
    id,
    vendorId,
    label: typeof input.label === 'string'
      ? input.label
      : (typeof current?.label === 'string' ? current.label : vendorId),
    authMode: typeof input.authMode === 'string'
      ? input.authMode
      : (typeof current?.authMode === 'string' ? current.authMode : 'api_key'),
    enabled: typeof input.enabled === 'boolean'
      ? input.enabled
      : (typeof current?.enabled === 'boolean' ? current.enabled : true),
    isDefault: typeof input.isDefault === 'boolean'
      ? input.isDefault
      : (typeof current?.isDefault === 'boolean' ? current.isDefault : false),
    headers,
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
    model: account.model,
    fallbackModels: Array.isArray(account.fallbackModels) ? account.fallbackModels : [],
    fallbackProviderIds: Array.isArray(account.fallbackAccountIds) ? account.fallbackAccountIds : [],
    enabled: account.enabled !== false,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    hasKey: typeof apiKey === 'string' && apiKey.trim().length > 0,
    keyMasked: maskProviderApiKeyLocal(apiKey),
  };
}

export function sortProviderAccountsLocal(accounts: any[], defaultAccountId: string | null) {
  return [...accounts].sort((left, right) => {
    if (left.id === defaultAccountId) return -1;
    if (right.id === defaultAccountId) return 1;
    const byUpdatedAt = String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''));
    if (byUpdatedAt !== 0) {
      return byUpdatedAt;
    }
    return String(left.id).localeCompare(String(right.id));
  });
}

export function normalizeProviderFallbackAccountLocal(accounts: any[], deletedId: string) {
  const remaining = accounts.filter((item) => item.id !== deletedId);
  if (remaining.length === 0) {
    return null;
  }
  const sorted = sortProviderAccountsLocal(remaining, null);
  return sorted[0]?.id || null;
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

export async function validateProviderApiKeyLocal(input: unknown) {
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
    baseUrl,
    apiProtocol,
    ...(headers ? { headers } : {}),
  });
}
