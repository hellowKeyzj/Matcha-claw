import type { ProviderProjectionSyncWorkflow } from '../workflows/provider-projection-sync/provider-projection-sync-workflow';

export type { ProviderProjectionPolicyPort } from './provider-projection-sync-plan';
export type { ProviderProjectionKeyResolverPort, ProviderStoreLike } from './provider-store-model';
export { normalizeProviderStoreForProjection } from './provider-store-model';
export type {
  ProviderProjectionAgentIdentityPort,
  ProviderProjectionAgentModelsPort,
  ProviderProjectionConfigPort,
  ProviderProjectionSecretPort,
  ProviderProjectionStatePort,
  ProviderProjectionSyncResult as ProviderStoreSyncResult,
} from '../workflows/provider-projection-sync/provider-projection-sync-workflow';

export class ProviderProjectionSyncService {
  constructor(
    private readonly syncWorkflow: Pick<ProviderProjectionSyncWorkflow, 'syncProviderStore'>,
  ) {}

  async syncProviderStore(store: import('./provider-store-model').ProviderStoreLike): Promise<import('../workflows/provider-projection-sync/provider-projection-sync-workflow').ProviderProjectionSyncResult> {
    return await this.syncWorkflow.syncProviderStore(store);
  }
}
