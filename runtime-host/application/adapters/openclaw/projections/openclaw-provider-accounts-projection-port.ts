import type { ProviderAccountsProjectionPort } from '../../../providers/provider-accounts-projection-port';
import type {
  ProviderProjectionKeyResolverPort,
  ProviderStoreLike,
  ProviderProjectionSyncService,
} from '../../../providers/store-sync';

export interface OpenClawProviderAccountSecretProjectionPort {
  removeProviderKey(providerKey: string): Promise<void>;
}

export interface OpenClawProviderAccountConfigProjectionPort {
  removeProvider(providerKey: string): Promise<void>;
}

function getStoredApiKey(store: ProviderStoreLike, key: string): string | undefined {
  const value = store.apiKeys[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function resolveRuntimeConfigProviderKey(projectionKeys: ProviderProjectionKeyResolverPort, accountId: string, account: Record<string, unknown> | null): string {
  const vendorId = typeof account?.vendorId === 'string' ? account.vendorId.trim() : '';
  return vendorId
    ? projectionKeys.resolveProviderKey({ vendorId, accountId, account: account ?? undefined })
    : accountId;
}

export class OpenClawProviderAccountsProjectionPort implements ProviderAccountsProjectionPort {
  constructor(
    private readonly authProfiles: OpenClawProviderAccountSecretProjectionPort,
    private readonly runtimeSync: Pick<ProviderProjectionSyncService, 'syncProviderStore'>,
    private readonly providerConfig: OpenClawProviderAccountConfigProjectionPort,
    private readonly projectionKeys: ProviderProjectionKeyResolverPort,
  ) {}

  async syncStoreToProjection(store: ProviderStoreLike): Promise<{ storeModified: boolean }> {
    return await this.runtimeSync.syncProviderStore(store);
  }

  async resolveAccountApiKey(input: {
    store: ProviderStoreLike;
    accountId: string;
    account: Record<string, unknown> | null;
  }): Promise<string | undefined> {
    const runtimeConfigProviderKey = resolveRuntimeConfigProviderKey(this.projectionKeys, input.accountId, input.account);
    const localApiKey = getStoredApiKey(input.store, input.accountId);
    if (localApiKey) {
      return localApiKey;
    }
    if (runtimeConfigProviderKey !== input.accountId) {
      return getStoredApiKey(input.store, runtimeConfigProviderKey);
    }
    return undefined;
  }

  resolveCleanupProviderKeys(input: {
    accountId: string;
    account: Record<string, unknown> | null;
  }): string[] {
    return Array.from(new Set([resolveRuntimeConfigProviderKey(this.projectionKeys, input.accountId, input.account), input.accountId]
      .filter((item) => item.trim().length > 0)));
  }

  async removeProviderKey(providerKey: string): Promise<void> {
    await this.authProfiles.removeProviderKey(providerKey);
  }

  async removeProviderConfig(providerKey: string): Promise<void> {
    await this.providerConfig.removeProvider(providerKey);
  }
}
