import {
  buildProviderProjectionSyncPlan,
  type ProviderProjectionPolicyPort,
} from '../../providers/provider-projection-sync-plan';
import {
  normalizeProviderStoreForProjection,
  type ProviderProjectionKeyResolverPort,
  type ProviderStoreLike,
} from '../../providers/provider-store-model';

export type ProviderProjectionSyncResult = {
  syncedApiKeyCount: number;
  storeModified: boolean;
};

export interface ProviderProjectionSecretPort {
  removeProviderKey(provider: string): Promise<void>;
  saveProviderKey(provider: string, apiKey: string): Promise<void>;
}

export interface ProviderProjectionConfigPort {
  syncProviderConfig(provider: string, override: Record<string, unknown>): Promise<void>;
  removeProvider(provider: string): Promise<void>;
}

export interface ProviderProjectionStatePort {
  getActiveProviders(): Promise<Set<string>>;
}

export interface ProviderProjectionAgentIdentityPort {
  discoverAgentIds(): Promise<string[]>;
}

export interface ProviderProjectionAgentModelsPort {
  upsertProviderInAgentModels(input: {
    agentIds: readonly string[];
    provider: string;
    entry: Record<string, unknown>;
  }): Promise<void>;
}

export interface ProviderProjectionSyncWorkflowDeps {
  readonly authProfiles: ProviderProjectionSecretPort;
  readonly providerConfig: ProviderProjectionConfigPort;
  readonly projectionState: ProviderProjectionStatePort;
  readonly authRepository: ProviderProjectionAgentIdentityPort;
  readonly agentModels: ProviderProjectionAgentModelsPort;
  readonly projectionKeys: ProviderProjectionKeyResolverPort;
  readonly projectionPolicy: ProviderProjectionPolicyPort;
}

export class ProviderProjectionSyncWorkflow {
  constructor(private readonly deps: ProviderProjectionSyncWorkflowDeps) {}

  async syncProviderStore(store: ProviderStoreLike): Promise<ProviderProjectionSyncResult> {
    const { accounts, storeModified } = normalizeProviderStoreForProjection(store, this.deps.projectionKeys);
    const plan = buildProviderProjectionSyncPlan(store, accounts, this.deps.projectionPolicy);
    const activeProviders = await this.deps.projectionState.getActiveProviders();
    const desiredProviders = new Set(plan.accountPlans.map((accountPlan) => accountPlan.providerKey));
    for (const provider of activeProviders) {
      if (!desiredProviders.has(provider)) {
        await this.deps.providerConfig.removeProvider(provider);
      }
    }
    const agentIds = await this.deps.authRepository.discoverAgentIds();
    let syncedApiKeyCount = 0;

    for (const accountPlan of plan.accountPlans) {
      if (accountPlan.runtimeConfigOverride) {
        await this.deps.providerConfig.syncProviderConfig(accountPlan.providerKey, accountPlan.runtimeConfigOverride);
      }

      if (accountPlan.apiKey) {
        await this.deps.authProfiles.saveProviderKey(accountPlan.providerKey, accountPlan.apiKey);
        if (accountPlan.providerKey !== accountPlan.accountId) {
          await this.deps.authProfiles.removeProviderKey(accountPlan.accountId);
        }
        syncedApiKeyCount += 1;
      } else {
        await this.deps.authProfiles.removeProviderKey(accountPlan.providerKey);
        if (accountPlan.providerKey !== accountPlan.accountId) {
          await this.deps.authProfiles.removeProviderKey(accountPlan.accountId);
        }
      }

      if (accountPlan.runtimeConfigOverride?.baseUrl && accountPlan.runtimeConfigOverride.api) {
        await this.deps.agentModels.upsertProviderInAgentModels({
          agentIds,
          provider: accountPlan.providerKey,
          entry: {
            baseUrl: accountPlan.runtimeConfigOverride.baseUrl,
            api: accountPlan.runtimeConfigOverride.api,
            ...(accountPlan.runtimeConfigOverride.headers ? { headers: accountPlan.runtimeConfigOverride.headers } : {}),
            ...(accountPlan.runtimeConfigOverride.authHeader !== undefined ? { authHeader: accountPlan.runtimeConfigOverride.authHeader } : {}),
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
