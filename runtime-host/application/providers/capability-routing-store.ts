import type { ProviderCapabilityRoutingStorePersistenceWorkflow } from '../workflows/provider-capability-routing-store/provider-capability-routing-store-persistence-workflow';
import type { CapabilityRouting } from './provider-types';

export interface CapabilityRoutingStoreRecord {
  schemaVersion: 1;
  routing: CapabilityRouting;
}

export interface CapabilityRoutingStorePort {
  read(): Promise<CapabilityRoutingStoreRecord>;
  write(store: CapabilityRoutingStoreRecord): Promise<void>;
}

export interface CapabilityRoutingStoragePort {
  getCapabilityRoutingStoreFilePath(): string;
  ensureParentDir(filePath: string): Promise<void>;
}

export interface CapabilityRoutingStoreRepositoryDeps {
  readonly persistenceWorkflow: Pick<ProviderCapabilityRoutingStorePersistenceWorkflow, 'read' | 'write'>;
}

export class CapabilityRoutingStoreRepository implements CapabilityRoutingStorePort {
  constructor(private readonly deps: CapabilityRoutingStoreRepositoryDeps) {}

  async read(): Promise<CapabilityRoutingStoreRecord> {
    return await this.deps.persistenceWorkflow.read();
  }

  async write(store: CapabilityRoutingStoreRecord): Promise<void> {
    await this.deps.persistenceWorkflow.write(store);
  }
}
