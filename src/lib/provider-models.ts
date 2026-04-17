import type { ProviderSnapshot } from '@/lib/provider-accounts';
import type { ProviderAccount, ProviderVendorInfo } from '@/lib/providers';
import type { ModelCatalogEntry } from '@/types/subagent';

const GOOGLE_BROWSER_OAUTH_RUNTIME_PROVIDER = 'google-gemini-cli';
const OPENAI_BROWSER_OAUTH_RUNTIME_PROVIDER = 'openai-codex';
const MULTI_INSTANCE_PROVIDER_TYPES = new Set(['custom', 'ollama']);

function getOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function getOpenClawProviderKey(type: string, providerId: string): string {
  if (MULTI_INSTANCE_PROVIDER_TYPES.has(type)) {
    const runtimeKeyPrefix = `${type}-`;
    if (providerId.startsWith(runtimeKeyPrefix)) {
      const suffix = providerId.slice(runtimeKeyPrefix.length);
      if (/^[A-Za-z0-9]{8}$/.test(suffix)) {
        return providerId;
      }
    }
    const suffix = providerId.replace(/-/g, '').slice(0, 8);
    return `${type}-${suffix}`;
  }
  if (type === 'minimax-portal-cn') {
    return 'minimax-portal';
  }
  return type;
}

function getRuntimeProviderKey(account: ProviderAccount): string {
  if (account.authMode === 'oauth_browser') {
    if (account.vendorId === 'google') {
      return GOOGLE_BROWSER_OAUTH_RUNTIME_PROVIDER;
    }
    if (account.vendorId === 'openai') {
      return OPENAI_BROWSER_OAUTH_RUNTIME_PROVIDER;
    }
  }
  return getOpenClawProviderKey(account.vendorId, account.id);
}

function buildProviderModelRef(
  providerKey: string,
  explicitModel?: string,
  defaultModel?: string,
): string | undefined {
  const rawModel = explicitModel || defaultModel;
  if (!rawModel) {
    return undefined;
  }
  return rawModel.startsWith(`${providerKey}/`)
    ? rawModel
    : `${providerKey}/${rawModel}`;
}

function extractTrailingModelId(value: string): string {
  const segments = value.split('/');
  return segments[segments.length - 1] || value;
}

function normalizeExplicitModel(account: ProviderAccount): string | undefined {
  const explicitModel = getOptionalString(account.model);
  if (!explicitModel) {
    return undefined;
  }
  if (account.authMode !== 'oauth_browser') {
    return explicitModel;
  }
  if (account.vendorId === 'openai') {
    return explicitModel.startsWith('openai/')
      ? undefined
      : extractTrailingModelId(explicitModel);
  }
  if (account.vendorId === 'google') {
    return extractTrailingModelId(explicitModel);
  }
  return explicitModel;
}

function buildModelEntry(modelRef: string, providerKey: string): ModelCatalogEntry {
  return {
    id: modelRef,
    provider: providerKey,
  };
}

function collectAccountModelRefs(
  account: ProviderAccount,
  vendor?: ProviderVendorInfo,
): string[] {
  const providerKey = getRuntimeProviderKey(account);
  const refs: string[] = [];
  const seen = new Set<string>();
  const push = (candidate?: string) => {
    const normalized = getOptionalString(candidate);
    if (!normalized) {
      return;
    }
    const modelRef = buildProviderModelRef(providerKey, normalized);
    if (!modelRef || seen.has(modelRef)) {
      return;
    }
    seen.add(modelRef);
    refs.push(modelRef);
  };

  const primaryModelRef = buildProviderModelRef(
    providerKey,
    normalizeExplicitModel(account),
    getOptionalString(vendor?.defaultModelId),
  );
  if (primaryModelRef) {
    seen.add(primaryModelRef);
    refs.push(primaryModelRef);
  }

  for (const fallbackModel of Array.isArray(account.fallbackModels) ? account.fallbackModels : []) {
    push(fallbackModel);
  }

  return refs;
}

export function buildSelectableProviderModels(snapshot: ProviderSnapshot): ModelCatalogEntry[] {
  const vendorById = new Map(snapshot.vendors.map((vendor) => [vendor.id, vendor]));
  const models: ModelCatalogEntry[] = [];
  const seen = new Set<string>();

  for (const account of snapshot.accounts) {
    const refs = collectAccountModelRefs(account, vendorById.get(account.vendorId));
    for (const ref of refs) {
      if (seen.has(ref)) {
        continue;
      }
      seen.add(ref);
      models.push(buildModelEntry(ref, getRuntimeProviderKey(account)));
    }
  }

  return models;
}
