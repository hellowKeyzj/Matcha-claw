export type ProviderStoreLike = {
  accounts: Record<string, Record<string, unknown>>;
  apiKeys: Record<string, string>;
  defaultAccountId?: unknown;
};

export type NormalizedProviderCredential = {
  accountId: string;
  providerKey: string;
  vendorId: string;
  account: Record<string, unknown>;
};

export interface ProviderProjectionKeyResolverPort {
  resolveProviderKey(input: { vendorId: string; accountId: string; account?: Record<string, unknown> }): string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function getOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function getPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

const EPOCH_ISO_TIMESTAMP = '1970-01-01T00:00:00.000Z';

function normalizeIsoTimestamp(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0
    ? value
    : EPOCH_ISO_TIMESTAMP;
}

function compareAccountsForRuntimeKey(left: NormalizedProviderCredential, right: NormalizedProviderCredential): number {
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

export function normalizeProviderStoreForProjection(
  store: ProviderStoreLike,
  projectionKeys: ProviderProjectionKeyResolverPort,
): {
  accounts: NormalizedProviderCredential[];
  storeModified: boolean;
} {
  let storeModified = false;

  const normalizedAccounts: NormalizedProviderCredential[] = [];
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
    for (const legacyKey of ['model', 'contextWindow', 'maxTokens', 'fallbackModels', 'fallbackAccountIds', 'isDefault']) {
      if (Object.prototype.hasOwnProperty.call(rawAccount, legacyKey)) {
        delete rawAccount[legacyKey];
        storeModified = true;
      }
    }
    const providerKey = projectionKeys.resolveProviderKey({ vendorId, accountId, account: rawAccount });
    normalizedAccounts.push({
      accountId,
      providerKey,
      vendorId,
      account: rawAccount,
    });
  }

  const groupedByProviderKey = new Map<string, NormalizedProviderCredential[]>();
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
    for (const duplicated of sorted.slice(1)) {
      delete store.accounts[duplicated.accountId];
      delete store.apiKeys[duplicated.accountId];
      storeModified = true;
    }
  }

  const dedupedAccounts = normalizedAccounts.filter(
    (account) => Boolean(store.accounts[account.accountId]),
  );
  if (Object.prototype.hasOwnProperty.call(store, 'defaultAccountId')) {
    delete store.defaultAccountId;
    storeModified = true;
  }
  return {
    accounts: dedupedAccounts,
    storeModified,
  };
}
