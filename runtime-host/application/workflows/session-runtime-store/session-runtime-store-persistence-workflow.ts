import { dirname, join } from 'node:path';
import type { RuntimeFileSystemPort } from '../../common/runtime-ports';
import type { PersistedSessionRuntimeStore } from '../../sessions/session-runtime-store-repository';
import type { SessionConfigDirectoryPort } from '../../sessions/session-storage-repository';

export interface SessionRuntimeStorePersistenceWorkflowDeps {
  readonly workspace: SessionConfigDirectoryPort;
  readonly fileSystem: RuntimeFileSystemPort;
}

export class SessionRuntimeStorePersistenceWorkflow {
  private readonly storeFilePath: string;

  constructor(private readonly deps: SessionRuntimeStorePersistenceWorkflowDeps) {
    this.storeFilePath = join(this.deps.workspace.getConfigDir(), 'matchaclaw-session-runtime-store.json');
  }

  async load(): Promise<PersistedSessionRuntimeStore> {
    try {
      const parsed = JSON.parse(await this.deps.fileSystem.readTextFile(this.storeFilePath)) as unknown;
      if (!parsed || typeof parsed !== 'object') {
        return createDefaultSessionRuntimeStore();
      }
      return {
        version: 3,
        activeSessionKey: normalizeActiveSessionKey((parsed as Record<string, unknown>).activeSessionKey),
      };
    } catch {
      return createDefaultSessionRuntimeStore();
    }
  }

  async save(store: PersistedSessionRuntimeStore): Promise<void> {
    const payload: PersistedSessionRuntimeStore = {
      version: 3,
      activeSessionKey: normalizeActiveSessionKey(store.activeSessionKey),
    };
    await this.deps.fileSystem.ensureDirectory(dirname(this.storeFilePath));
    await this.deps.fileSystem.writeTextFile(this.storeFilePath, JSON.stringify(payload, null, 2));
  }
}

function normalizeActiveSessionKey(value: unknown): string | null {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : null;
}

function createDefaultSessionRuntimeStore(): PersistedSessionRuntimeStore {
  return {
    version: 3,
    activeSessionKey: null,
  };
}
