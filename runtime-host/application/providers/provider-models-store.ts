import type { ProviderModelsStorePersistenceWorkflow } from '../workflows/provider-models-store/provider-models-store-persistence-workflow';
import type { ProviderModel } from './provider-types';

export interface ProviderModelsStoreRecord {
  schemaVersion: 1;
  models: ProviderModel[];
}

export interface ProviderModelsStorePort {
  read(): Promise<ProviderModelsStoreRecord>;
  write(store: ProviderModelsStoreRecord): Promise<void>;
}

export interface ProviderModelsStoragePort {
  getProviderModelsStoreFilePath(): string;
  ensureParentDir(filePath: string): Promise<void>;
}

export interface ProviderModelsStoreRepositoryDeps {
  readonly persistenceWorkflow: Pick<ProviderModelsStorePersistenceWorkflow, 'read' | 'write'>;
}

export class ProviderModelsStoreRepository implements ProviderModelsStorePort {
  constructor(private readonly deps: ProviderModelsStoreRepositoryDeps) {}

  async read(): Promise<ProviderModelsStoreRecord> {
    return await this.deps.persistenceWorkflow.read();
  }

  async write(store: ProviderModelsStoreRecord): Promise<void> {
    await this.deps.persistenceWorkflow.write(store);
  }
}
