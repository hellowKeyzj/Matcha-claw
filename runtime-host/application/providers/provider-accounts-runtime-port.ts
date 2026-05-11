import {
  getOpenClawProviderKeyForType,
} from './provider-runtime-rules';
import {
  type ProviderStoreLike,
  type ProviderRuntimeSyncService,
} from './store-sync';
import type { OpenClawAuthProfileService } from '../openclaw/openclaw-auth-profile-store';
import type { OpenClawProviderConfigService } from '../openclaw/openclaw-provider-config-service';

export interface ProviderAccountsRuntimePort {
  syncStoreToRuntime(store: ProviderStoreLike): Promise<{ storeModified: boolean }>;
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

function getStoredApiKey(store: ProviderStoreLike, key: string): string | undefined {
  const value = store.apiKeys[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function resolveRuntimeProviderKey(accountId: string, account: Record<string, unknown> | null): string {
  const providerType = typeof account?.vendorId === 'string' ? account.vendorId.trim() : '';
  return providerType
    ? getOpenClawProviderKeyForType(providerType, accountId)
    : accountId;
}

export class OpenClawProviderAccountsRuntimePort implements ProviderAccountsRuntimePort {
  constructor(
    private readonly authProfiles: Pick<OpenClawAuthProfileService, 'getProviderApiKey' | 'removeProviderKey'>,
    private readonly runtimeSync: Pick<ProviderRuntimeSyncService, 'syncProviderStore'>,
    private readonly providerConfig: Pick<OpenClawProviderConfigService, 'removeProvider'>,
  ) {}

  async syncStoreToRuntime(store: ProviderStoreLike): Promise<{ storeModified: boolean }> {
    return await this.runtimeSync.syncProviderStore(store);
  }

  async resolveAccountApiKey(input: {
    store: ProviderStoreLike;
    accountId: string;
    account: Record<string, unknown> | null;
  }): Promise<string | undefined> {
    const runtimeProviderKey = resolveRuntimeProviderKey(input.accountId, input.account);
    const runtimeApiKey = await this.authProfiles.getProviderApiKey(runtimeProviderKey);
    if (runtimeApiKey) {
      return runtimeApiKey;
    }
    const localApiKey = getStoredApiKey(input.store, input.accountId);
    if (localApiKey) {
      return localApiKey;
    }
    if (runtimeProviderKey !== input.accountId) {
      return getStoredApiKey(input.store, runtimeProviderKey);
    }
    return undefined;
  }

  resolveCleanupProviderKeys(input: {
    accountId: string;
    account: Record<string, unknown> | null;
  }): string[] {
    return Array.from(new Set([resolveRuntimeProviderKey(input.accountId, input.account), input.accountId]
      .filter((item) => item.trim().length > 0)));
  }

  async removeProviderKey(providerKey: string): Promise<void> {
    await this.authProfiles.removeProviderKey(providerKey);
  }

  async removeProviderConfig(providerKey: string): Promise<void> {
    await this.providerConfig.removeProvider(providerKey);
  }
}
