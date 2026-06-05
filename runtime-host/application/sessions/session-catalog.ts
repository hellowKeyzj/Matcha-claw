import type {
  SessionListResult,
} from '../../shared/session-adapter-types';
import type { RuntimeAddress } from '../agent-runtime/contracts/runtime-address';
import type {
  SessionStorageDescriptor,
} from './session-storage-repository';
import type {
  SessionCatalogRuntimeOverlay,
  SessionCatalogWorkflow,
} from '../workflows/session-catalog/session-catalog-workflow';

export type { SessionCatalogRuntimeOverlay };
export { parseSessionKeyAgent } from '../workflows/session-catalog/session-catalog-workflow';

export interface SessionCatalogServiceDeps {
  catalogWorkflow: Pick<SessionCatalogWorkflow,
    | 'listStorageDescriptors'
    | 'refreshCache'
    | 'getSnapshotMeta'
    | 'listSessions'
    | 'scanSessions'
  >;
}

export interface SessionCatalogPort {
  listStorageDescriptors(): Promise<SessionStorageDescriptor[]>;
  refreshCache(): Promise<void>;
  getSnapshotMeta(): {
    ready: boolean;
    updatedAt: number | null;
    error: string | null;
  };
  listSessions(input: {
    runtimeAddress: RuntimeAddress;
    runtimeOverlays?: readonly SessionCatalogRuntimeOverlay[];
  }): Promise<SessionListResult>;
  scanSessions(): Promise<SessionListResult>;
}

export class SessionCatalogService implements SessionCatalogPort {
  constructor(private readonly deps: SessionCatalogServiceDeps) {}

  async listStorageDescriptors(): Promise<SessionStorageDescriptor[]> {
    return await this.deps.catalogWorkflow.listStorageDescriptors();
  }

  async refreshCache(): Promise<void> {
    await this.deps.catalogWorkflow.refreshCache();
  }

  getSnapshotMeta(): {
    ready: boolean;
    updatedAt: number | null;
    error: string | null;
  } {
    return this.deps.catalogWorkflow.getSnapshotMeta();
  }

  async listSessions(input: {
    runtimeAddress: RuntimeAddress;
    runtimeOverlays?: readonly SessionCatalogRuntimeOverlay[];
  }): Promise<SessionListResult> {
    return await this.deps.catalogWorkflow.listSessions(input);
  }

  async scanSessions(): Promise<SessionListResult> {
    return await this.deps.catalogWorkflow.scanSessions();
  }
}
