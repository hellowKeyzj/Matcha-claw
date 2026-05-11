import type { RuntimeFileSystemPort } from '../common/runtime-ports';
import type { OpenClawEnvironmentRepository } from '../openclaw/openclaw-environment-repository';

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export interface ProviderStoreRecord {
  schemaVersion: 1;
  defaultAccountId: string | null;
  accounts: Record<string, Record<string, unknown>>;
  apiKeys: Record<string, string>;
}

export interface ProviderStorePort {
  read(): Promise<ProviderStoreRecord>;
  write(store: ProviderStoreRecord): Promise<void>;
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
    schemaVersion: 1,
    defaultAccountId: null,
    accounts: {},
    apiKeys: {},
  };
}

export class ProviderStoreRepository implements ProviderStorePort {
  constructor(
    private readonly environment: OpenClawEnvironmentRepository,
    private readonly fileSystem: RuntimeFileSystemPort,
  ) {}

  async read(): Promise<ProviderStoreRecord> {
    const filePath = this.environment.getProviderStoreFilePath();
    try {
      const raw = await this.fileSystem.readTextFile(filePath);
      const parsed = JSON.parse(raw);
      if (!isRecord(parsed)) {
        return createEmptyProviderStore();
      }
      return {
        schemaVersion: 1,
        defaultAccountId: typeof parsed.defaultAccountId === 'string' ? parsed.defaultAccountId : null,
        accounts: normalizeRecordMap(parsed.accounts),
        apiKeys: normalizeStringMap(parsed.apiKeys),
      };
    } catch {
      return createEmptyProviderStore();
    }
  }

  async write(store: ProviderStoreRecord) {
    const filePath = this.environment.getProviderStoreFilePath();
    await this.environment.ensureParentDir(filePath);
    await this.fileSystem.writeTextFile(filePath, `${JSON.stringify(store, null, 2)}\n`);
  }
}
