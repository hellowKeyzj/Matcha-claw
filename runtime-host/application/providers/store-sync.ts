import type { OpenClawAuthProfileService } from '../openclaw/openclaw-auth-profile-store';
import type { OpenClawProviderConfigService } from '../openclaw/openclaw-provider-config-service';
import {
  buildProviderRuntimeSyncPlan,
} from './provider-runtime-sync-plan';
import {
  normalizeProviderStoreForRuntime,
  type ProviderStoreLike,
} from './provider-store-model';

export type { ProviderStoreLike } from './provider-store-model';
export { normalizeProviderStoreForRuntime } from './provider-store-model';

export type ProviderStoreSyncResult = {
  syncedApiKeyCount: number;
  storeModified: boolean;
};

export class ProviderRuntimeSyncService {
  constructor(
    private readonly authProfiles: Pick<OpenClawAuthProfileService, 'saveProviderKey' | 'removeProviderKey'>,
    private readonly providerConfig: Pick<OpenClawProviderConfigService, 'syncProviderConfig'>,
  ) {}

  async syncProviderStore(store: ProviderStoreLike): Promise<ProviderStoreSyncResult> {
    const { accounts, storeModified } = normalizeProviderStoreForRuntime(store);
    const plan = buildProviderRuntimeSyncPlan(store, accounts);
    let syncedApiKeyCount = 0;

    for (const accountPlan of plan.accountPlans) {
      if (accountPlan.apiKey) {
        await this.authProfiles.saveProviderKey(accountPlan.providerKey, accountPlan.apiKey);
        syncedApiKeyCount += 1;
      } else {
        await this.authProfiles.removeProviderKey(accountPlan.providerKey);
        if (accountPlan.providerKey !== accountPlan.accountId) {
          await this.authProfiles.removeProviderKey(accountPlan.accountId);
        }
      }

      if (accountPlan.runtimeOverride) {
        await this.providerConfig.syncProviderConfig(accountPlan.providerKey, accountPlan.runtimeOverride);
      }
    }

    return {
      syncedApiKeyCount,
      storeModified,
    };
  }
}
