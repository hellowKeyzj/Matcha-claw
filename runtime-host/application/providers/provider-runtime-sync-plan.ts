import {
  getOAuthApiKeyEnv,
  getOAuthProviderApi,
  normalizeOAuthBaseUrl,
  usesOAuthAuthHeader,
} from './provider-runtime-rules';
import {
  getOptionalString,
  getPositiveInteger,
  toStringArray,
  type NormalizedProviderAccount,
  type ProviderStoreLike,
} from './provider-store-model';

type ProviderRuntimeProtocol =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages';

export type RuntimeProviderConfigOverride = {
  baseUrl?: string;
  api?: string;
  apiKeyEnv?: string;
  headers?: Record<string, string>;
  authHeader?: boolean;
  models?: Array<{
    id: string;
    name: string;
    contextWindow?: number;
    maxTokens?: number;
  }>;
};

export interface ProviderRuntimeAccountSyncPlan {
  accountId: string;
  providerKey: string;
  apiKey: string | null;
  runtimeOverride?: RuntimeProviderConfigOverride;
}

export interface ProviderRuntimeDefaultModelPlan {
  providerKey: string;
  defaultModel?: string;
  fallbackModels: string[];
  runtimeOverride?: RuntimeProviderConfigOverride;
}

export interface ProviderRuntimeSyncPlan {
  accountPlans: ProviderRuntimeAccountSyncPlan[];
  defaultModelPlan?: ProviderRuntimeDefaultModelPlan;
}

function normalizeProviderProtocol(protocol: unknown): ProviderRuntimeProtocol {
  if (protocol === 'openai-responses') {
    return 'openai-responses';
  }
  if (protocol === 'anthropic-messages') {
    return 'anthropic-messages';
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
  apiProtocol: ProviderRuntimeProtocol,
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

function normalizeFallbackModelRefs(providerKey: string, fallbackModels: unknown): string[] {
  const normalized: string[] = [];
  for (const model of toStringArray(fallbackModels)) {
    normalized.push(model.startsWith(`${providerKey}/`) ? model : `${providerKey}/${model}`);
  }
  return normalized;
}

function buildRuntimeProviderModels(
  account: Record<string, unknown>,
): Array<{
  id: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
}> {
  const models: Array<{
    id: string;
    name: string;
    contextWindow?: number;
    maxTokens?: number;
  }> = [];
  const seen = new Set<string>();
  const push = (
    modelId: string | undefined,
    capabilities?: { contextWindow?: number; maxTokens?: number },
  ) => {
    if (!modelId || seen.has(modelId)) {
      return;
    }
    seen.add(modelId);
    models.push({
      id: modelId,
      name: modelId,
      contextWindow: capabilities?.contextWindow,
      maxTokens: capabilities?.maxTokens,
    });
  };

  push(getOptionalString(account.model), {
    contextWindow: getPositiveInteger(account.contextWindow),
    maxTokens: getPositiveInteger(account.maxTokens),
  });
  for (const fallbackModel of toStringArray(account.fallbackModels)) {
    push(fallbackModel);
  }

  return models;
}

function ensureHttpsPrefix(value: string): string {
  if (value.startsWith('http://') || value.startsWith('https://')) {
    return value;
  }
  return `https://${value}`;
}

export function resolveRuntimeProviderConfigOverride(
  providerKey: string,
  account: Record<string, unknown>,
): RuntimeProviderConfigOverride | undefined {
  const vendorId = getOptionalString(account.vendorId);
  if (!vendorId) {
    return undefined;
  }

  if (vendorId === 'custom' || vendorId === 'ollama') {
    const protocol = normalizeProviderProtocol(account.apiProtocol);
    return {
      baseUrl: normalizeProviderBaseUrl(vendorId, account.baseUrl, protocol),
      api: protocol,
      headers: normalizeProviderHeaders(account.headers),
      models: buildRuntimeProviderModels(account),
    };
  }

  if (account.authMode !== 'oauth_device') {
    return undefined;
  }
  const oauthApi = getOAuthProviderApi(vendorId);
  if (!oauthApi) {
    return undefined;
  }

  const normalizedOAuthBaseUrl = normalizeOAuthBaseUrl(vendorId, getOptionalString(account.baseUrl));
  const apiKeyEnv = getOAuthApiKeyEnv(providerKey);
  return {
    ...(normalizedOAuthBaseUrl ? { baseUrl: ensureHttpsPrefix(normalizedOAuthBaseUrl) } : {}),
    api: oauthApi,
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    ...(usesOAuthAuthHeader(providerKey) ? { authHeader: true } : {}),
  };
}

export function buildProviderRuntimeSyncPlan(
  store: ProviderStoreLike,
  accounts: NormalizedProviderAccount[],
): ProviderRuntimeSyncPlan {
  const accountPlans = accounts.map(({ accountId, providerKey, account }) => {
    const apiKey = typeof store.apiKeys[accountId] === 'string' ? store.apiKeys[accountId].trim() : '';
    return {
      accountId,
      providerKey,
      apiKey: apiKey || null,
      runtimeOverride: resolveRuntimeProviderConfigOverride(providerKey, account),
    };
  });

  const defaultAccountEntry = typeof store.defaultAccountId === 'string'
    ? accounts.find((account) => account.accountId === store.defaultAccountId)
    : null;
  return {
    accountPlans,
    ...(defaultAccountEntry
      ? {
          defaultModelPlan: {
            providerKey: defaultAccountEntry.providerKey,
            defaultModel: getOptionalString(defaultAccountEntry.account.model),
            fallbackModels: normalizeFallbackModelRefs(
              defaultAccountEntry.providerKey,
              defaultAccountEntry.account.fallbackModels,
            ),
            runtimeOverride: resolveRuntimeProviderConfigOverride(
              defaultAccountEntry.providerKey,
              defaultAccountEntry.account,
            ),
          },
        }
      : {}),
  };
}
