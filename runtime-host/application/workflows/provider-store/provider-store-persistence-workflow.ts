import type { RuntimeFileSystemPort } from '../../common/runtime-ports';
import type {
  ProviderStoreRecord,
  ProviderStoreStoragePort,
} from '../../providers/provider-store-repository';

export interface ProviderStorePersistenceWorkflowDeps {
  readonly storage: ProviderStoreStoragePort;
  readonly fileSystem: RuntimeFileSystemPort;
}

export class ProviderStorePersistenceWorkflow {
  private cachedStore: ProviderStoreRecord | null = null;
  private cachedStat: { size: number; mtimeMs: number } | null = null;

  constructor(private readonly deps: ProviderStorePersistenceWorkflowDeps) {}

  async read(): Promise<ProviderStoreRecord> {
    const filePath = this.deps.storage.getProviderStoreFilePath();
    const stat = await this.readProviderStoreStat(filePath);

    if (
      stat
      && this.cachedStore
      && this.cachedStat
      && this.cachedStat.size === stat.size
      && this.cachedStat.mtimeMs === stat.mtimeMs
    ) {
      return cloneProviderStore(this.cachedStore);
    }

    try {
      const raw = await this.deps.fileSystem.readTextFile(filePath);
      const parsed = JSON.parse(raw);
      const normalized = isRecord(parsed)
        ? {
          schemaVersion: 2 as const,
          accounts: normalizeRecordMap(parsed.accounts),
          apiKeys: normalizeStringMap(parsed.apiKeys),
        }
        : createEmptyProviderStore();
      this.cachedStore = cloneProviderStore(normalized);
      this.cachedStat = stat;
      return normalized;
    } catch {
      this.cachedStore = null;
      this.cachedStat = null;
      return createEmptyProviderStore();
    }
  }

  async write(store: ProviderStoreRecord): Promise<void> {
    const filePath = this.deps.storage.getProviderStoreFilePath();
    await this.deps.storage.ensureParentDir(filePath);
    await this.deps.fileSystem.writeTextFile(filePath, `${JSON.stringify(store, null, 2)}\n`);
    this.cachedStore = null;
    this.cachedStat = null;
  }

  private async readProviderStoreStat(filePath: string): Promise<{ size: number; mtimeMs: number } | null> {
    try {
      const fileStat = await this.deps.fileSystem.stat(filePath);
      return { size: fileStat.size, mtimeMs: fileStat.mtimeMs };
    } catch {
      return null;
    }
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeRecordMap(value: unknown): Record<string, Record<string, unknown>> {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1])),
  );
}

function normalizeStringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

function createEmptyProviderStore(): ProviderStoreRecord {
  return {
    schemaVersion: 2,
    accounts: {},
    apiKeys: {},
  };
}

function cloneProviderStore(store: ProviderStoreRecord): ProviderStoreRecord {
  return {
    schemaVersion: store.schemaVersion,
    accounts: Object.fromEntries(
      Object.entries(store.accounts).map(([id, account]) => [id, { ...account }]),
    ),
    apiKeys: { ...store.apiKeys },
  };
}
