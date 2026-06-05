import type { ProviderStorePersistenceWorkflow } from '../workflows/provider-store/provider-store-persistence-workflow';

export interface ProviderStoreRecord {
  schemaVersion: 2;
  accounts: Record<string, Record<string, unknown>>;
  apiKeys: Record<string, string>;
}

export interface ProviderStorePort {
  read(): Promise<ProviderStoreRecord>;
  write(store: ProviderStoreRecord): Promise<void>;
}

export interface ProviderStoreStoragePort {
  getProviderStoreFilePath(): string;
  ensureParentDir(filePath: string): Promise<void>;
}

export interface ProviderStoreRepositoryDeps {
  readonly persistenceWorkflow: Pick<ProviderStorePersistenceWorkflow, 'read' | 'write'>;
}

export class ProviderStoreRepository implements ProviderStorePort {
  constructor(private readonly deps: ProviderStoreRepositoryDeps) {}

  async read(): Promise<ProviderStoreRecord> {
    return await this.deps.persistenceWorkflow.read();
  }

  async write(store: ProviderStoreRecord): Promise<void> {
    await this.deps.persistenceWorkflow.write(store);
  }
}
