import { getProviderBackendConfig } from './provider-registry';
import {
  getOptionalString,
  type NormalizedProviderCredential,
  type ProviderStoreLike,
} from './provider-store-model';

type ProviderProjectionProtocol =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'openrouter'
  | 'google-generative-ai';

export type RuntimeConfigProviderOverride = {
  baseUrl?: string;
  api?: string;
  apiKeyEnv?: string;
  headers?: Record<string, string>;
  authHeader?: boolean;
  replaceProviderKeys?: readonly string[];
};

export interface ProviderProjectionPolicyPort {
  getReplaceProviderKeys(input: { vendorId: string; accountId: string }): readonly string[];
  getOAuthProviderApi(vendorId: string): 'anthropic-messages' | 'openai-completions' | undefined;
  getOAuthProviderTokenKey(vendorId: string): string;
  getOAuthProviderDefaultBaseUrl(vendorId: string): string | undefined;
  normalizeOAuthBaseUrl(vendorId: string, baseUrl?: string): string | undefined;
  getOAuthApiKeyEnv(providerKey: string): string | undefined;
  usesOAuthAuthHeader(providerKey: string): boolean;
}

export interface ProviderProjectionAccountSyncPlan {
  accountId: string;
  providerKey: string;
  apiKey: string | null;
  runtimeConfigOverride?: RuntimeConfigProviderOverride;
}

export interface ProviderProjectionSyncPlan {
  accountPlans: ProviderProjectionAccountSyncPlan[];
}

function normalizeProviderProtocol(protocol: unknown): ProviderProjectionProtocol {
  if (protocol === 'openai-responses') {
    return 'openai-responses';
  }
  if (protocol === 'anthropic-messages') {
    return 'anthropic-messages';
  }
  if (protocol === 'openrouter') {
    return 'openrouter';
  }
  return 'openai-completions';
}

function normalizeProviderHeaders(headers: unknown): Record<string, string> | undefined {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    return undefined;
  }
  const normalizedEntries: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.trim().length > 0 && typeof value === 'string' && value.trim().length > 0) {
      normalizedEntries.push([key, value.trim()]);
    }
  }
  const normalized = Object.fromEntries(normalizedEntries);
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeProviderBaseUrl(
  vendorId: string,
  baseUrl: unknown,
  apiProtocol: ProviderProjectionProtocol,
): string | undefined {
  if (typeof baseUrl !== 'string' || baseUrl.trim().length === 0) {
    return undefined;
  }

  const normalized = baseUrl.trim().replace(/\/+$/, '');
  if (vendorId !== 'custom' && vendorId !== 'ollama') {
    return normalized;
  }

  if (apiProtocol === 'openai-responses') {
    return normalized.replace(/\/responses?$/i, '');
  }
  if (apiProtocol === 'anthropic-messages') {
    return normalized.replace(/\/v1\/messages$/i, '').replace(/\/messages$/i, '');
  }
  return normalized.replace(/\/chat\/completions$/i, '');
}

function ensureHttpsPrefix(value: string): string {
  if (value.startsWith('http://') || value.startsWith('https://')) {
    return value;
  }
  return `https://${value}`;
}

export function resolveRuntimeConfigProviderOverride(
  providerKey: string,
  account: Record<string, unknown>,
  projectionPolicy: ProviderProjectionPolicyPort,
): RuntimeConfigProviderOverride | undefined {
  const vendorId = getOptionalString(account.vendorId);
  if (!vendorId) {
    return undefined;
  }

  if (vendorId === 'custom' && account.providerKind === 'media') {
    return undefined;
  }

  if (vendorId === 'custom' || vendorId === 'ollama') {
    const protocol = normalizeProviderProtocol(account.apiProtocol);
    const accountId = getOptionalString(account.id) || providerKey;
    const replaceProviderKeys = projectionPolicy.getReplaceProviderKeys({ vendorId, accountId });
    return {
      baseUrl: normalizeProviderBaseUrl(vendorId, account.baseUrl, protocol),
      api: protocol,
      ...(replaceProviderKeys.length > 0 ? { replaceProviderKeys } : {}),
      headers: normalizeProviderHeaders(account.headers),
    };
  }

  if (account.authMode === 'oauth_device') {
    const oauthApi = projectionPolicy.getOAuthProviderApi(vendorId);
    if (!oauthApi) {
      return undefined;
    }

    const normalizedOAuthBaseUrl = projectionPolicy.normalizeOAuthBaseUrl(vendorId, getOptionalString(account.baseUrl));
    const apiKeyEnv = projectionPolicy.getOAuthApiKeyEnv(providerKey);
    return {
      ...(normalizedOAuthBaseUrl ? { baseUrl: ensureHttpsPrefix(normalizedOAuthBaseUrl) } : {}),
      api: oauthApi,
      ...(apiKeyEnv ? { apiKeyEnv } : {}),
      ...(projectionPolicy.usesOAuthAuthHeader(providerKey) ? { authHeader: true } : {}),
    };
  }

  const providerConfig = getProviderBackendConfig(vendorId);
  if (!providerConfig) {
    return undefined;
  }
  return {
    baseUrl: normalizeProviderBaseUrl(vendorId, getOptionalString(account.baseUrl) ?? providerConfig.baseUrl, providerConfig.api),
    api: providerConfig.api,
    headers: normalizeProviderHeaders(providerConfig.headers),
  };
}

export function buildProviderProjectionSyncPlan(
  store: ProviderStoreLike,
  accounts: NormalizedProviderCredential[],
  projectionPolicy: ProviderProjectionPolicyPort,
): ProviderProjectionSyncPlan {
  const accountPlans = accounts.map(({ accountId, providerKey, account }) => {
    const apiKey = typeof store.apiKeys[accountId] === 'string' ? store.apiKeys[accountId].trim() : '';
    return {
      accountId,
      providerKey: providerKey || accountId,
      apiKey: apiKey || null,
      runtimeConfigOverride: resolveRuntimeConfigProviderOverride(providerKey, account, projectionPolicy),
    };
  });
  return { accountPlans };
}
