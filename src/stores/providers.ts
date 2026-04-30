/**
 * Provider State Store
 * Manages AI provider configurations
 */
import { create } from 'zustand';
import type {
  ProviderAccount,
  ProviderWithKeyInfo,
} from '@/lib/providers';
import {
  fetchProviderSnapshot,
  normalizeProviderSnapshot,
  type ProviderSnapshot,
} from '@/lib/provider-accounts';
import {
  hostProviderCreateAccount,
  hostProviderDeleteAccount,
  hostProviderReadApiKey,
  hostProviderSetDefaultAccount,
  hostProviderUpdateAccount,
  hostProviderValidate,
} from '@/lib/provider-runtime';
import { startUiTiming, trackUiEvent } from '@/lib/telemetry';

const PROVIDER_SNAPSHOT_TIMEOUT_MS = 20000;
const PROVIDER_SNAPSHOT_CACHE_KEY = 'matchaclaw:providers:snapshot:v1';
const DEFAULT_PROVIDER_SCOPE_KEY = 'default';

let inflightProviderSnapshotTask: Promise<void> | null = null;
let latestProviderSnapshotRequestId = 0;

function withTimeout<T>(task: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
    task.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function createEmptySnapshot(): ProviderSnapshot {
  return {
    statuses: [],
    accounts: [],
    vendors: [],
    defaultAccountId: null,
  };
}

function cloneSnapshot(snapshot: ProviderSnapshot): ProviderSnapshot {
  return {
    statuses: [...snapshot.statuses],
    accounts: [...snapshot.accounts],
    vendors: [...snapshot.vendors],
    defaultAccountId: snapshot.defaultAccountId ?? null,
  };
}

function getLocalStorageSafe(): Storage | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

type PersistedProviderSnapshot = {
  version: 1;
  scopeKey: string;
  snapshot: ProviderSnapshot;
  cachedAtMs: number;
};

function readPersistedSnapshot(scopeKey: string): ProviderSnapshot | null {
  const storage = getLocalStorageSafe();
  if (!storage) {
    return null;
  }

  try {
    const raw = storage.getItem(PROVIDER_SNAPSHOT_CACHE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<PersistedProviderSnapshot>;
    if (parsed.version !== 1 || parsed.scopeKey !== scopeKey) {
      return null;
    }
    return normalizeProviderSnapshot(parsed.snapshot);
  } catch {
    return null;
  }
}

function writePersistedSnapshot(scopeKey: string, snapshot: ProviderSnapshot): void {
  const storage = getLocalStorageSafe();
  if (!storage) {
    return;
  }

  try {
    const payload: PersistedProviderSnapshot = {
      version: 1,
      scopeKey,
      snapshot,
      cachedAtMs: Date.now(),
    };
    storage.setItem(PROVIDER_SNAPSHOT_CACHE_KEY, JSON.stringify(payload));
  } catch {
    // ignore cache write errors
  }
}

function clearPersistedSnapshot(): void {
  const storage = getLocalStorageSafe();
  if (!storage) {
    return;
  }

  try {
    storage.removeItem(PROVIDER_SNAPSHOT_CACHE_KEY);
  } catch {
    // ignore
  }
}

function isAuthModeCredentialBased(authMode: ProviderAccount['authMode']): boolean {
  return authMode === 'oauth_device' || authMode === 'oauth_browser' || authMode === 'local';
}

function inferHasKey(account: ProviderAccount, apiKey?: string): boolean {
  if (isAuthModeCredentialBased(account.authMode)) {
    return true;
  }
  return Boolean(apiKey?.trim());
}

function toProviderStatus(account: ProviderAccount, hasKey: boolean): ProviderWithKeyInfo {
  return {
    id: account.id,
    name: account.label || account.vendorId,
    type: account.vendorId,
    baseUrl: account.baseUrl,
    apiProtocol: account.apiProtocol,
    headers: account.headers,
    model: account.model,
    contextWindow: account.contextWindow,
    maxTokens: account.maxTokens,
    fallbackModels: account.fallbackModels,
    fallbackProviderIds: account.fallbackAccountIds,
    enabled: account.enabled,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    hasKey,
    keyMasked: hasKey ? '****' : null,
  };
}

function syncStatusWithAccount(
  status: ProviderWithKeyInfo,
  account: ProviderAccount,
  options?: { hasKeyOverride?: boolean },
): ProviderWithKeyInfo {
  return {
    ...status,
    name: account.label || status.name,
    type: account.vendorId,
    baseUrl: account.baseUrl,
    apiProtocol: account.apiProtocol,
    headers: account.headers,
    model: account.model,
    contextWindow: account.contextWindow,
    maxTokens: account.maxTokens,
    fallbackModels: account.fallbackModels,
    fallbackProviderIds: account.fallbackAccountIds,
    enabled: account.enabled,
    updatedAt: account.updatedAt,
    hasKey: options?.hasKeyOverride ?? status.hasKey,
  };
}

export type ProviderMutationKind = 'create' | 'update' | 'delete' | 'setDefault';
export type ProviderMutationTracker = Partial<Record<ProviderMutationKind, number>>;
export type ProviderMutatingMap = Record<string, ProviderMutationTracker>;
export type ProviderRefreshTrigger = 'manual' | 'background' | 'reconcile';

interface ProviderRefreshOptions {
  trigger?: ProviderRefreshTrigger;
  reason?: string;
}

function incrementMutation(
  map: ProviderMutatingMap,
  accountId: string,
  mutationKind: ProviderMutationKind,
): ProviderMutatingMap {
  const current = map[accountId] ?? {};
  const nextCount = (current[mutationKind] ?? 0) + 1;
  return {
    ...map,
    [accountId]: {
      ...current,
      [mutationKind]: nextCount,
    },
  };
}

function decrementMutation(
  map: ProviderMutatingMap,
  accountId: string,
  mutationKind: ProviderMutationKind,
): ProviderMutatingMap {
  const current = map[accountId];
  if (!current || !current[mutationKind]) {
    return map;
  }

  const nextCount = (current[mutationKind] ?? 1) - 1;
  const nextEntry: ProviderMutationTracker = { ...current };
  if (nextCount <= 0) {
    delete nextEntry[mutationKind];
  } else {
    nextEntry[mutationKind] = nextCount;
  }

  const hasAny = Object.values(nextEntry).some((count) => (count ?? 0) > 0);
  if (!hasAny) {
    const { [accountId]: _ignored, ...rest } = map;
    return rest;
  }

  return {
    ...map,
    [accountId]: nextEntry,
  };
}

function hasAnyMutating(map: ProviderMutatingMap): boolean {
  return Object.values(map).some((entry) => Object.values(entry).some((count) => (count ?? 0) > 0));
}

function snapshotFingerprint(snapshot: ProviderSnapshot): string {
  return JSON.stringify(snapshot);
}

function resolveRefreshEventName(trigger: ProviderRefreshTrigger): string {
  return `providers.snapshot_refresh.${trigger}`;
}

function resolveRefreshReason(trigger: ProviderRefreshTrigger, reason?: string): string {
  if (reason?.trim()) {
    return reason;
  }
  if (trigger === 'manual') {
    return 'manual_refresh';
  }
  if (trigger === 'reconcile') {
    return 'post_mutation_reconcile';
  }
  return 'background_refresh';
}

function resolveDefaultAccountIdAfterRemoval(
  snapshot: ProviderSnapshot,
  removedAccountId: string,
): string | null {
  if (snapshot.defaultAccountId !== removedAccountId) {
    return snapshot.defaultAccountId;
  }

  const fallback = snapshot.accounts.find((account) => account.id !== removedAccountId);
  return fallback?.id ?? null;
}

const initialScopeKey = DEFAULT_PROVIDER_SCOPE_KEY;
const initialPersistedSnapshot = readPersistedSnapshot(initialScopeKey);

// Re-export types for consumers that imported from here
export type {
  ProviderAccount,
  ProviderVendorInfo,
  ProviderWithKeyInfo,
} from '@/lib/providers';
export type { ProviderSnapshot } from '@/lib/provider-accounts';

interface ProviderState {
  providerSnapshot: ProviderSnapshot;
  snapshotReady: boolean;
  scopeKey: string;
  initialLoading: boolean;
  refreshing: boolean;
  mutating: boolean;
  mutatingActionsByAccountId: ProviderMutatingMap;
  error: string | null;

  // Actions
  init: () => Promise<void>;
  refreshProviderSnapshot: (options?: ProviderRefreshOptions) => Promise<void>;
  resetProviderScope: (scopeKey?: string) => void;
  createAccount: (account: ProviderAccount, apiKey?: string) => Promise<void>;
  updateAccount: (accountId: string, updates: Partial<ProviderAccount>, apiKey?: string) => Promise<void>;
  removeAccount: (accountId: string) => Promise<void>;
  setDefaultAccount: (accountId: string) => Promise<void>;
  validateAccountApiKey: (
    accountOrVendorId: string,
    apiKey: string,
    options?: {
      baseUrl?: string;
      apiProtocol?: ProviderAccount['apiProtocol'];
      headers?: Record<string, string>;
    }
  ) => Promise<{ valid: boolean; error?: string }>;
  getAccountApiKey: (accountId: string) => Promise<string | null>;
}

export const useProviderStore = create<ProviderState>((set, get) => ({
  providerSnapshot: initialPersistedSnapshot ? cloneSnapshot(initialPersistedSnapshot) : createEmptySnapshot(),
  snapshotReady: Boolean(initialPersistedSnapshot),
  scopeKey: initialScopeKey,
  initialLoading: false,
  refreshing: false,
  mutating: false,
  mutatingActionsByAccountId: {},
  error: null,

  init: async () => {
    await get().refreshProviderSnapshot({ trigger: 'background', reason: 'app_init' });
  },

  refreshProviderSnapshot: async (options) => {
    const trigger = options?.trigger ?? 'background';
    const reason = resolveRefreshReason(trigger, options?.reason);
    const refreshEvent = resolveRefreshEventName(trigger);

    if (inflightProviderSnapshotTask) {
      const endJoinTiming = startUiTiming(refreshEvent, {
        reason,
        phase: 'join',
        deduped: true,
      });
      await inflightProviderSnapshotTask;
      const sharedResult = get().error ? 'error' : 'success';
      endJoinTiming({
        result: sharedResult,
        cacheHit: get().snapshotReady,
      });
      trackUiEvent(`${refreshEvent}.${sharedResult}`, {
        reason,
        phase: 'join',
        deduped: true,
        cacheHit: get().snapshotReady,
      });
      return;
    }

    const requestId = ++latestProviderSnapshotRequestId;
    const stateBeforeRefresh = get();
    const hasSnapshot = stateBeforeRefresh.snapshotReady;
    const silentRefresh = trigger === 'background' && hasSnapshot;
    const previousFingerprint = snapshotFingerprint(stateBeforeRefresh.providerSnapshot);
    const endRefreshTiming = startUiTiming(refreshEvent, {
      reason,
      phase: 'owner',
      deduped: false,
      cacheHit: hasSnapshot,
    });

    if (hasSnapshot) {
      if (silentRefresh) {
        set({ refreshing: false, initialLoading: false, error: null });
      } else {
        set({ refreshing: true, initialLoading: false, error: null });
      }
    } else {
      set({ initialLoading: true, refreshing: false, error: null });
    }

    let currentTask: Promise<void> | null = null;
    const task = (async () => {
      try {
        const snapshot = await withTimeout(
          fetchProviderSnapshot(),
          PROVIDER_SNAPSHOT_TIMEOUT_MS,
          `Provider snapshot request timed out after ${String(PROVIDER_SNAPSHOT_TIMEOUT_MS)}ms`,
        );
        if (requestId !== latestProviderSnapshotRequestId) {
          endRefreshTiming({
            result: 'stale_ignored',
            cacheHit: hasSnapshot,
          });
          trackUiEvent(`${refreshEvent}.stale_ignored`, {
            reason,
            cacheHit: hasSnapshot,
          });
          return;
        }

        const normalizedSnapshot = normalizeProviderSnapshot(snapshot);
        const changed = snapshotFingerprint(normalizedSnapshot) !== previousFingerprint;
        writePersistedSnapshot(get().scopeKey, normalizedSnapshot);
        set({
          providerSnapshot: normalizedSnapshot,
          snapshotReady: true,
          initialLoading: false,
          refreshing: false,
          error: null,
        });
        endRefreshTiming({
          result: 'success',
          cacheHit: hasSnapshot,
          changed,
          accountCount: normalizedSnapshot.accounts.length,
          statusCount: normalizedSnapshot.statuses.length,
          vendorCount: normalizedSnapshot.vendors.length,
        });
        trackUiEvent(`${refreshEvent}.success`, {
          reason,
          cacheHit: hasSnapshot,
          changed,
          accountCount: normalizedSnapshot.accounts.length,
        });
      } catch (error) {
        if (requestId !== latestProviderSnapshotRequestId) {
          endRefreshTiming({
            result: 'stale_ignored',
            cacheHit: hasSnapshot,
          });
          trackUiEvent(`${refreshEvent}.stale_ignored`, {
            reason,
            cacheHit: hasSnapshot,
          });
          return;
        }
        const errorText = String(error);
        const result = /timed out/i.test(errorText) ? 'timeout' : 'error';
        set({
          error: errorText,
          initialLoading: false,
          refreshing: false,
        });
        endRefreshTiming({
          result,
          cacheHit: hasSnapshot,
          hasSnapshotAfterError: get().snapshotReady,
          message: errorText,
        });
        trackUiEvent(`${refreshEvent}.${result}`, {
          reason,
          cacheHit: hasSnapshot,
          hasSnapshotAfterError: get().snapshotReady,
          message: errorText,
        });
      } finally {
        if (inflightProviderSnapshotTask === currentTask) {
          inflightProviderSnapshotTask = null;
        }
      }
    })();

    currentTask = task;
    inflightProviderSnapshotTask = task;
    await task;
  },

  resetProviderScope: (scopeKey = DEFAULT_PROVIDER_SCOPE_KEY) => {
    latestProviderSnapshotRequestId += 1;
    inflightProviderSnapshotTask = null;
    clearPersistedSnapshot();
    const persisted = readPersistedSnapshot(scopeKey);

    set({
      scopeKey,
      providerSnapshot: persisted ? cloneSnapshot(persisted) : createEmptySnapshot(),
      snapshotReady: Boolean(persisted),
      initialLoading: false,
      refreshing: false,
      error: null,
      mutating: false,
      mutatingActionsByAccountId: {},
    });
  },

  createAccount: async (account, apiKey) => {
    set((state) => {
      const nextMutating = incrementMutation(state.mutatingActionsByAccountId, account.id, 'create');
      return {
        mutatingActionsByAccountId: nextMutating,
        mutating: hasAnyMutating(nextMutating),
      };
    });

    try {
      const result = await hostProviderCreateAccount(account, apiKey);
      if (!result.success) {
        throw new Error(result.error || 'Failed to create provider account');
      }

      set((state) => {
        const baseSnapshot = state.providerSnapshot;
        const nextAccounts = [
          ...baseSnapshot.accounts.filter((item) => item.id !== account.id),
          account,
        ];

        const hasKey = inferHasKey(account, apiKey);
        const existingStatus = baseSnapshot.statuses.find((status) => status.id === account.id);
        const nextStatuses = existingStatus
          ? baseSnapshot.statuses.map((status) => (
            status.id === account.id ? syncStatusWithAccount(status, account, { hasKeyOverride: hasKey }) : status
          ))
          : [...baseSnapshot.statuses, toProviderStatus(account, hasKey)];

        const nextSnapshot: ProviderSnapshot = {
          ...baseSnapshot,
          accounts: nextAccounts,
          statuses: nextStatuses,
        };

        writePersistedSnapshot(state.scopeKey, nextSnapshot);
        return {
          providerSnapshot: nextSnapshot,
          snapshotReady: true,
          error: null,
        };
      });

      void get().refreshProviderSnapshot({
        trigger: 'reconcile',
        reason: 'mutation_create',
      });
    } catch (error) {
      console.error('Failed to add account:', error);
      throw error;
    } finally {
      set((state) => {
        const nextMutating = decrementMutation(state.mutatingActionsByAccountId, account.id, 'create');
        return {
          mutatingActionsByAccountId: nextMutating,
          mutating: hasAnyMutating(nextMutating),
        };
      });
    }
  },

  updateAccount: async (accountId, updates, apiKey) => {
    set((state) => {
      const nextMutating = incrementMutation(state.mutatingActionsByAccountId, accountId, 'update');
      return {
        mutatingActionsByAccountId: nextMutating,
        mutating: hasAnyMutating(nextMutating),
      };
    });

    try {
      const result = await hostProviderUpdateAccount(accountId, updates, apiKey);
      if (!result.success) {
        throw new Error(result.error || 'Failed to update provider account');
      }

      set((state) => {
        const baseSnapshot = state.providerSnapshot;
        const existingAccount = baseSnapshot.accounts.find((item) => item.id === accountId);
        if (!existingAccount) {
          return {};
        }

        const patchedAccount: ProviderAccount = {
          ...existingAccount,
          ...updates,
          updatedAt: new Date().toISOString(),
        };

        const nextAccounts = baseSnapshot.accounts.map((item) => (
          item.id === accountId ? patchedAccount : item
        ));

        const existingStatus = baseSnapshot.statuses.find((status) => status.id === accountId);
        const hasKeyOverride = apiKey?.trim() ? true : undefined;
        const nextStatuses = existingStatus
          ? baseSnapshot.statuses.map((status) => (
            status.id === accountId
              ? syncStatusWithAccount(status, patchedAccount, { hasKeyOverride })
              : status
          ))
          : [...baseSnapshot.statuses, toProviderStatus(patchedAccount, inferHasKey(patchedAccount, apiKey))];

        const nextSnapshot: ProviderSnapshot = {
          ...baseSnapshot,
          accounts: nextAccounts,
          statuses: nextStatuses,
        };

        writePersistedSnapshot(state.scopeKey, nextSnapshot);
        return {
          providerSnapshot: nextSnapshot,
          snapshotReady: true,
          error: null,
        };
      });

      void get().refreshProviderSnapshot({
        trigger: 'reconcile',
        reason: 'mutation_update',
      });
    } catch (error) {
      console.error('Failed to update account:', error);
      throw error;
    } finally {
      set((state) => {
        const nextMutating = decrementMutation(state.mutatingActionsByAccountId, accountId, 'update');
        return {
          mutatingActionsByAccountId: nextMutating,
          mutating: hasAnyMutating(nextMutating),
        };
      });
    }
  },

  removeAccount: async (accountId) => {
    set((state) => {
      const nextMutating = incrementMutation(state.mutatingActionsByAccountId, accountId, 'delete');
      return {
        mutatingActionsByAccountId: nextMutating,
        mutating: hasAnyMutating(nextMutating),
      };
    });

    try {
      const result = await hostProviderDeleteAccount(accountId);
      if (!result.success) {
        throw new Error(result.error || 'Failed to delete provider account');
      }

      set((state) => {
        const baseSnapshot = state.providerSnapshot;
        const nextSnapshot: ProviderSnapshot = {
          ...baseSnapshot,
          accounts: baseSnapshot.accounts.filter((item) => item.id !== accountId),
          statuses: baseSnapshot.statuses.filter((status) => status.id !== accountId),
          defaultAccountId: resolveDefaultAccountIdAfterRemoval(baseSnapshot, accountId),
        };

        writePersistedSnapshot(state.scopeKey, nextSnapshot);
        return {
          providerSnapshot: nextSnapshot,
          snapshotReady: true,
          error: null,
        };
      });

      void get().refreshProviderSnapshot({
        trigger: 'reconcile',
        reason: 'mutation_remove',
      });
    } catch (error) {
      console.error('Failed to delete account:', error);
      throw error;
    } finally {
      set((state) => {
        const nextMutating = decrementMutation(state.mutatingActionsByAccountId, accountId, 'delete');
        return {
          mutatingActionsByAccountId: nextMutating,
          mutating: hasAnyMutating(nextMutating),
        };
      });
    }
  },

  setDefaultAccount: async (accountId) => {
    set((state) => {
      const nextMutating = incrementMutation(state.mutatingActionsByAccountId, accountId, 'setDefault');
      return {
        mutatingActionsByAccountId: nextMutating,
        mutating: hasAnyMutating(nextMutating),
      };
    });

    try {
      const result = await hostProviderSetDefaultAccount(accountId);
      if (!result.success) {
        throw new Error(result.error || 'Failed to set default provider account');
      }

      set((state) => {
        const baseSnapshot = state.providerSnapshot;
        const nextSnapshot: ProviderSnapshot = {
          ...baseSnapshot,
          defaultAccountId: accountId,
          accounts: baseSnapshot.accounts.map((account) => ({
            ...account,
            isDefault: account.id === accountId,
          })),
        };

        writePersistedSnapshot(state.scopeKey, nextSnapshot);
        return {
          providerSnapshot: nextSnapshot,
          snapshotReady: true,
          error: null,
        };
      });

      void get().refreshProviderSnapshot({
        trigger: 'reconcile',
        reason: 'mutation_set_default',
      });
    } catch (error) {
      console.error('Failed to set default account:', error);
      throw error;
    } finally {
      set((state) => {
        const nextMutating = decrementMutation(state.mutatingActionsByAccountId, accountId, 'setDefault');
        return {
          mutatingActionsByAccountId: nextMutating,
          mutating: hasAnyMutating(nextMutating),
        };
      });
    }
  },

  validateAccountApiKey: async (accountOrVendorId, apiKey, options) => {
    try {
      const account = get().providerSnapshot.accounts.find((candidate) => candidate.id === accountOrVendorId);
      const payload = account
        ? { accountId: account.id, vendorId: account.vendorId, apiKey, options }
        : { vendorId: accountOrVendorId, apiKey, options };
      const result = await hostProviderValidate(payload);
      return result;
    } catch (error) {
      return { valid: false, error: String(error) };
    }
  },

  getAccountApiKey: async (accountId) => {
    try {
      const result = await hostProviderReadApiKey(accountId);
      return result.apiKey;
    } catch {
      return null;
    }
  },
}));
