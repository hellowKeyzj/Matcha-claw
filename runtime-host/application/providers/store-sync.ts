import type { OpenClawAgentModelRepositoryPort } from '../openclaw/openclaw-agent-model-repository';
import type { OpenClawAuthProfileService } from '../openclaw/openclaw-auth-profile-store';
import type { OpenClawAuthRepository } from '../openclaw/openclaw-auth-store';
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
    private readonly authProfiles: Pick<OpenClawAuthProfileService, 'removeProviderKey' | 'saveProviderKey'>,
    private readonly providerConfig: Pick<OpenClawProviderConfigService, 'syncProviderConfig'>,
    private readonly authRepository: Pick<OpenClawAuthRepository, 'discoverAgentIds'>,
    private readonly agentModels: Pick<OpenClawAgentModelRepositoryPort, 'upsertProviderInAgentModels'>,
  ) {}

  async syncProviderStore(store: ProviderStoreLike): Promise<ProviderStoreSyncResult> {
    const { accounts, storeModified } = normalizeProviderStoreForRuntime(store);
    const plan = buildProviderRuntimeSyncPlan(store, accounts);
    const agentIds = await this.authRepository.discoverAgentIds();
    let syncedApiKeyCount = 0;

    for (const accountPlan of plan.accountPlans) {
      if (accountPlan.runtimeOverride) {
        await this.providerConfig.syncProviderConfig(accountPlan.providerKey, accountPlan.runtimeOverride);
      }

      if (accountPlan.apiKey) {
        await this.authProfiles.saveProviderKey(accountPlan.providerKey, accountPlan.apiKey);
        if (accountPlan.providerKey !== accountPlan.accountId) {
          await this.authProfiles.removeProviderKey(accountPlan.accountId);
        }
        syncedApiKeyCount += 1;
      } else {
        await this.authProfiles.removeProviderKey(accountPlan.providerKey);
        if (accountPlan.providerKey !== accountPlan.accountId) {
          await this.authProfiles.removeProviderKey(accountPlan.accountId);
        }
      }

      if (accountPlan.runtimeOverride?.baseUrl && accountPlan.runtimeOverride.api) {
        await this.agentModels.upsertProviderInAgentModels({
          agentIds,
          provider: accountPlan.providerKey,
          entry: {
            baseUrl: accountPlan.runtimeOverride.baseUrl,
            api: accountPlan.runtimeOverride.api,
            ...(accountPlan.runtimeOverride.headers ? { headers: accountPlan.runtimeOverride.headers } : {}),
            ...(accountPlan.runtimeOverride.authHeader !== undefined ? { authHeader: accountPlan.runtimeOverride.authHeader } : {}),
          },
        });
      }
    }

    return {
      syncedApiKeyCount,
      storeModified,
    };
  }
}
