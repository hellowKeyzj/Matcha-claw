import type { SessionRuntimeStorePersistenceWorkflow } from '../workflows/session-runtime-store/session-runtime-store-persistence-workflow';

export interface PersistedSessionRuntimeStore {
  version: 3;
  activeSessionKey: string | null;
}

export interface SessionRuntimeStoreRepositoryDeps {
  persistenceWorkflow: Pick<SessionRuntimeStorePersistenceWorkflow, 'load' | 'save'>;
}

export interface SessionRuntimeStorePort {
  load(): Promise<PersistedSessionRuntimeStore>;
  save(store: PersistedSessionRuntimeStore): Promise<void>;
}

export class SessionRuntimeStoreRepository implements SessionRuntimeStorePort {
  constructor(private readonly deps: SessionRuntimeStoreRepositoryDeps) {}

  async load(): Promise<PersistedSessionRuntimeStore> {
    return await this.deps.persistenceWorkflow.load();
  }

  async save(store: PersistedSessionRuntimeStore): Promise<void> {
    await this.deps.persistenceWorkflow.save(store);
  }
}
