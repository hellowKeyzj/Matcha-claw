import type { ProviderStoreLike } from './store-sync';

export interface ProviderAccountsProjectionPort {
  syncStoreToProjection(store: ProviderStoreLike): Promise<{ storeModified: boolean }>;
  resolveAccountApiKey(input: {
    store: ProviderStoreLike;
    accountId: string;
    account: Record<string, unknown> | null;
  }): Promise<string | undefined>;
  resolveCleanupProviderKeys(input: {
    accountId: string;
    account: Record<string, unknown> | null;
  }): string[];
  removeProviderKey(providerKey: string): Promise<void>;
  removeProviderConfig(providerKey: string): Promise<void>;
}
