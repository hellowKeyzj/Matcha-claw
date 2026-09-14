/**
 * Provider State Store
 * Manages AI provider configurations
 */
import { create } from 'zustand';
import type { ProviderCredential } from '@/lib/providers';
import {
  fetchProviderSnapshot,
  normalizeProviderSnapshot,
  type ProviderSnapshot,
} from '@/lib/provider-accounts';
import {
  hostProviderCreateAccount,
  hostProviderDeleteAccount,
  hostProviderUpdateAccount,
} from '@/lib/provider-projection';
import { startUiTiming, trackUiEvent } from '@/lib/telemetry';
import type { ProviderMutationReceipt } from '@/lib/host-api-transport-contract';
import { nativeProjectionError } from '@/lib/provider-projection-errors';

const PROVIDER_SNAPSHOT_TIMEOUT_MS = 20000;
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
    credentials: [],
    vendors: [],
    revisions: {},
  };
}

export type ProviderMutationKind = 'create' | 'update' | 'delete';
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

const initialScopeKey = DEFAULT_PROVIDER_SCOPE_KEY;

// Re-export types for consumers that imported from here
export type {
  ProviderCredential,
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
  warning: string | null;
  lastMutationReceipt: ProviderMutationReceipt | null;

  // Actions
  init: () => Promise<void>;
  refreshProviderSnapshot: (options: ProviderRefreshOptions) => Promise<void>;
  resetProviderScope: (scopeKey?: string) => void;
  createAccount: (account: ProviderCredential, apiKey?: string, token?: string) => Promise<void>;
  updateAccount: (accountId: string, updates: Partial<ProviderCredential>, apiKey?: string, token?: string) => Promise<void>;
  removeAccount: (accountId: string) => Promise<void>;
}

function providerNativeWarning(receipt: ProviderMutationReceipt | undefined): string | null {
  return receipt ? nativeProjectionError(receipt) ?? null : null;
}

export const useProviderStore = create<ProviderState>((set, get) => ({
  providerSnapshot: createEmptySnapshot(),
  snapshotReady: false,
  scopeKey: initialScopeKey,
  initialLoading: false,
  refreshing: false,
  mutating: false,
  mutatingActionsByAccountId: {},
  error: null,
  warning: null,
  lastMutationReceipt: null,

  init: async () => {
    await get().refreshProviderSnapshot({ trigger: 'background', reason: 'app_init' });
  },

  refreshProviderSnapshot: async (options) => {
    const trigger = options.trigger ?? 'background';
    const reason = resolveRefreshReason(trigger, options.reason);
    const refreshEvent = resolveRefreshEventName(trigger);

    if (inflightProviderSnapshotTask && trigger !== 'reconcile') {
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
        set({
          providerSnapshot: normalizedSnapshot,
          snapshotReady: true,
          initialLoading: false,
          refreshing: false,
          error: null,
          warning: get().warning,
        });
        endRefreshTiming({
          result: 'success',
          cacheHit: hasSnapshot,
          changed,
          accountCount: normalizedSnapshot.credentials.length,
          statusCount: normalizedSnapshot.statuses.length,
          vendorCount: normalizedSnapshot.vendors.length,
        });
        trackUiEvent(`${refreshEvent}.success`, {
          reason,
          cacheHit: hasSnapshot,
          changed,
          accountCount: normalizedSnapshot.credentials.length,
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

    set({
      scopeKey,
      providerSnapshot: createEmptySnapshot(),
      snapshotReady: false,
      initialLoading: false,
      refreshing: false,
      error: null,
      warning: null,
      mutating: false,
      mutatingActionsByAccountId: {},
      lastMutationReceipt: null,
    });
  },

  createAccount: async (account, apiKey, token) => {
    set((state) => {
      const nextMutating = incrementMutation(state.mutatingActionsByAccountId, account.id, 'create');
      return {
        mutatingActionsByAccountId: nextMutating,
        mutating: hasAnyMutating(nextMutating),
      };
    });

    try {
      const result = await hostProviderCreateAccount(account, apiKey, token);
      if (!result.success) {
        set({ lastMutationReceipt: result.receipt ?? null, warning: null });
        throw new Error(result.error || 'Failed to create provider account');
      }
      set({ lastMutationReceipt: result.receipt ?? null, warning: result.warning ?? providerNativeWarning(result.receipt) });
      await get().refreshProviderSnapshot({
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

  updateAccount: async (accountId, updates, apiKey, token) => {
    set((state) => {
      const nextMutating = incrementMutation(state.mutatingActionsByAccountId, accountId, 'update');
      return {
        mutatingActionsByAccountId: nextMutating,
        mutating: hasAnyMutating(nextMutating),
      };
    });

    try {
      const currentState = get();
      const existingAccount = currentState.providerSnapshot.credentials.find((item) => item.id === accountId);
      const currentRevision = currentState.providerSnapshot.revisions[accountId];
      if (!existingAccount || !currentRevision) {
        throw new Error('Provider account is unavailable');
      }
      const nextRevision = currentRevision + 1;
      const patchedAccount: ProviderCredential = {
        ...existingAccount,
        ...updates,
        updatedAt: new Date().toISOString(),
      };
      const result = await hostProviderUpdateAccount(patchedAccount, nextRevision, apiKey, token);
      if (!result.success) {
        set({ lastMutationReceipt: result.receipt ?? null, warning: null });
        throw new Error(result.error || 'Failed to update provider account');
      }
      set({ lastMutationReceipt: result.receipt ?? null, warning: result.warning ?? providerNativeWarning(result.receipt) });
      await get().refreshProviderSnapshot({
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
      const revision = get().providerSnapshot.revisions[accountId];
      if (!revision) {
        throw new Error('Provider account is unavailable');
      }
      const result = await hostProviderDeleteAccount(accountId, revision);
      if (!result.success) {
        set({ lastMutationReceipt: result.receipt ?? null, warning: null });
        throw new Error(result.error || 'Failed to delete provider account');
      }
      set({ lastMutationReceipt: result.receipt ?? null, warning: result.warning ?? providerNativeWarning(result.receipt) });
      await get().refreshProviderSnapshot({
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

}));
