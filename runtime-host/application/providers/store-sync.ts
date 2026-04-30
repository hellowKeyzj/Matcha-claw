import { removeProviderKeyFromOpenClaw, saveProviderKeyToOpenClaw } from '../openclaw/openclaw-auth-profile-store';
import {
  setOpenClawDefaultModel,
  setOpenClawDefaultModelWithOverride,
  syncProviderConfigToOpenClaw,
} from '../openclaw/openclaw-provider-config-service';
import {
  getOAuthApiKeyEnv,
  getOAuthProviderApi,
  getOpenClawProviderKeyForType,
  normalizeOAuthBaseUrl,
  usesOAuthAuthHeader,
} from './provider-runtime-rules';

type ProviderRuntimeProtocol =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages';

type RuntimeProviderConfigOverride = {
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

export type ProviderStoreLike = {
  defaultAccountId: string | null;
  accounts: Record<string, unknown>;
  apiKeys: Record<string, string>;
};

type NormalizedProviderAccount = {
  accountId: string;
  providerKey: string;
  vendorId: string;
  account: Record<string, unknown>;
};

export type ProviderStoreSyncResult = {
  syncedApiKeyCount: number;
  defaultProviderId?: string;
  storeModified: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function getPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
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
  const normalized = Object.fromEntries(
    Object.entries(headers as Record<string, unknown>)
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

function normalizeIsoTimestamp(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0
    ? value
    : new Date(0).toISOString();
}

function compareAccountsForRuntimeKey(left: NormalizedProviderAccount, right: NormalizedProviderAccount): number {
  const leftAliasPriority = left.vendorId !== left.providerKey ? 1 : 0;
  const rightAliasPriority = right.vendorId !== right.providerKey ? 1 : 0;
  if (leftAliasPriority !== rightAliasPriority) {
    return rightAliasPriority - leftAliasPriority;
  }
  const byUpdatedAt = normalizeIsoTimestamp((right.account as { updatedAt?: unknown }).updatedAt)
    .localeCompare(normalizeIsoTimestamp((left.account as { updatedAt?: unknown }).updatedAt));
  if (byUpdatedAt !== 0) {
    return byUpdatedAt;
  }
  return left.accountId.localeCompare(right.accountId);
}

function ensureHttpsPrefix(value: string): string {
  if (value.startsWith('http://') || value.startsWith('https://')) {
    return value;
  }
  return `https://${value}`;
}

function resolveRuntimeProviderConfigOverride(
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

function sortAccountsForDefaultSelection(accounts: NormalizedProviderAccount[]): NormalizedProviderAccount[] {
  return [...accounts].sort((left, right) => {
    const byUpdatedAt = normalizeIsoTimestamp((right.account as { updatedAt?: unknown }).updatedAt)
      .localeCompare(normalizeIsoTimestamp((left.account as { updatedAt?: unknown }).updatedAt));
    if (byUpdatedAt !== 0) {
      return byUpdatedAt;
    }
    return left.accountId.localeCompare(right.accountId);
  });
}

export function normalizeProviderStoreForRuntime(store: ProviderStoreLike): {
  accounts: NormalizedProviderAccount[];
  storeModified: boolean;
} {
  let storeModified = false;

  const normalizedAccounts: NormalizedProviderAccount[] = [];
  for (const [accountId, rawAccount] of Object.entries(store.accounts)) {
    if (!isRecord(rawAccount)) {
      delete store.accounts[accountId];
      delete store.apiKeys[accountId];
      storeModified = true;
      continue;
    }
    const vendorId = getOptionalString(rawAccount.vendorId);
    if (!vendorId) {
      delete store.accounts[accountId];
      delete store.apiKeys[accountId];
      storeModified = true;
      continue;
    }
    if (rawAccount.id !== accountId) {
      rawAccount.id = accountId;
      storeModified = true;
    }
    if (rawAccount.vendorId !== vendorId) {
      rawAccount.vendorId = vendorId;
      storeModified = true;
    }
    const providerKey = getOpenClawProviderKeyForType(vendorId, accountId);
    normalizedAccounts.push({
      accountId,
      providerKey,
      vendorId,
      account: rawAccount,
    });
  }

  const groupedByProviderKey = new Map<string, NormalizedProviderAccount[]>();
  for (const account of normalizedAccounts) {
    const group = groupedByProviderKey.get(account.providerKey) ?? [];
    group.push(account);
    groupedByProviderKey.set(account.providerKey, group);
  }

  for (const group of groupedByProviderKey.values()) {
    if (group.length <= 1) {
      continue;
    }
    const sorted = [...group].sort(compareAccountsForRuntimeKey);
    const keep = sorted[0];
    for (const duplicated of sorted.slice(1)) {
      delete store.accounts[duplicated.accountId];
      delete store.apiKeys[duplicated.accountId];
      if (store.defaultAccountId === duplicated.accountId) {
        store.defaultAccountId = keep.accountId;
      }
      storeModified = true;
    }
  }

  const dedupedAccounts: NormalizedProviderAccount[] = normalizedAccounts.filter(
    (account) => Boolean(store.accounts[account.accountId]),
  );
  const dedupedAccountIds = new Set(dedupedAccounts.map((account) => account.accountId));

  const nextDefaultAccountId = store.defaultAccountId && dedupedAccountIds.has(store.defaultAccountId)
    ? store.defaultAccountId
    : (() => {
        const fallback = sortAccountsForDefaultSelection(dedupedAccounts)[0];
        return fallback ? fallback.accountId : null;
      })();
  if (store.defaultAccountId !== nextDefaultAccountId) {
    store.defaultAccountId = nextDefaultAccountId;
    storeModified = true;
  }

  for (const account of dedupedAccounts) {
    const shouldBeDefault = Boolean(store.defaultAccountId) && account.accountId === store.defaultAccountId;
    if (account.account.isDefault !== shouldBeDefault) {
      account.account.isDefault = shouldBeDefault;
      storeModified = true;
    }
  }

  return {
    accounts: dedupedAccounts,
    storeModified,
  };
}

export async function syncProviderStoreToOpenClaw(store: ProviderStoreLike): Promise<ProviderStoreSyncResult> {
  const { accounts, storeModified } = normalizeProviderStoreForRuntime(store);
  let syncedApiKeyCount = 0;

  for (const accountEntry of accounts) {
    const { accountId, providerKey, account } = accountEntry;
    const apiKey = typeof store.apiKeys[accountId] === 'string' ? store.apiKeys[accountId].trim() : '';
    if (apiKey) {
      await saveProviderKeyToOpenClaw(providerKey, apiKey);
      syncedApiKeyCount += 1;
    } else {
      await removeProviderKeyFromOpenClaw(providerKey);
      if (providerKey !== accountId) {
        await removeProviderKeyFromOpenClaw(accountId);
      }
    }

    const runtimeOverride = resolveRuntimeProviderConfigOverride(providerKey, account);
    if (runtimeOverride) {
      await syncProviderConfigToOpenClaw(providerKey, runtimeOverride);
    }
  }

  const defaultProviderId = typeof store.defaultAccountId === 'string'
    ? store.defaultAccountId
    : undefined;
  if (defaultProviderId) {
    const defaultAccountEntry = accounts.find((account) => account.accountId === defaultProviderId);
    if (defaultAccountEntry) {
      const defaultModel = getOptionalString(defaultAccountEntry.account.model);
      const fallbackModels = normalizeFallbackModelRefs(
        defaultAccountEntry.providerKey,
        defaultAccountEntry.account.fallbackModels,
      );
      const runtimeOverride = resolveRuntimeProviderConfigOverride(
        defaultAccountEntry.providerKey,
        defaultAccountEntry.account,
      );
      if (runtimeOverride) {
        await setOpenClawDefaultModelWithOverride(
          defaultAccountEntry.providerKey,
          defaultModel,
          runtimeOverride,
          fallbackModels,
        );
      } else {
        await setOpenClawDefaultModel(defaultAccountEntry.providerKey, defaultModel, fallbackModels);
      }
    }
  }

  return {
    syncedApiKeyCount,
    ...(defaultProviderId ? { defaultProviderId } : {}),
    storeModified,
  };
}
