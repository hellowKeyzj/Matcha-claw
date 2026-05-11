import { getOpenClawProviderKeyForType } from './provider-runtime-rules';

export type ProviderStoreLike = {
  defaultAccountId: string | null;
  accounts: Record<string, Record<string, unknown>>;
  apiKeys: Record<string, string>;
};

export type NormalizedProviderAccount = {
  accountId: string;
  providerKey: string;
  vendorId: string;
  account: Record<string, unknown>;
};

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

export function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

const EPOCH_ISO_TIMESTAMP = '1970-01-01T00:00:00.000Z';

function normalizeIsoTimestamp(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0
    ? value
    : EPOCH_ISO_TIMESTAMP;
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

  const dedupedAccounts = normalizedAccounts.filter(
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
