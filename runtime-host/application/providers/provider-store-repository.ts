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

function cloneProviderStore(store: ProviderStoreRecord): ProviderStoreRecord {
  return {
    schemaVersion: store.schemaVersion,
    defaultAccountId: store.defaultAccountId,
    accounts: Object.fromEntries(
      Object.entries(store.accounts).map(([id, account]) => [id, { ...account }]),
    ),
    apiKeys: { ...store.apiKeys },
  };
}

export class ProviderStoreRepository implements ProviderStorePort {
  // 缓存上次磁盘 read 的结果。每次 read 先 stat，size + mtimeMs 一致就直接 clone 返回，
  // 不再 readTextFile + JSON.parse。write 成功后主动重置为 null 让下一次 read 强制刷新，
  // 避免本进程外其他写入路径带来的脏读。
  private cachedStore: ProviderStoreRecord | null = null;
  private cachedStat: { size: number; mtimeMs: number } | null = null;

  constructor(
    private readonly environment: OpenClawEnvironmentRepository,
    private readonly fileSystem: RuntimeFileSystemPort,
  ) {}

  async read(): Promise<ProviderStoreRecord> {
    const filePath = this.environment.getProviderStoreFilePath();
    let stat: { size: number; mtimeMs: number } | null = null;
    try {
      const fileStat = await this.fileSystem.stat(filePath);
      stat = { size: fileStat.size, mtimeMs: fileStat.mtimeMs };
    } catch {
      // 文件不存在或 stat 失败时退回到磁盘读路径，让原有 try/catch 处理空 store 兜底。
    }

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
      const raw = await this.fileSystem.readTextFile(filePath);
      const parsed = JSON.parse(raw);
      const normalized = isRecord(parsed)
        ? {
          schemaVersion: 1 as const,
          defaultAccountId: typeof parsed.defaultAccountId === 'string' ? parsed.defaultAccountId : null,
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

  async write(store: ProviderStoreRecord) {
    const filePath = this.environment.getProviderStoreFilePath();
    await this.environment.ensureParentDir(filePath);
    await this.fileSystem.writeTextFile(filePath, `${JSON.stringify(store, null, 2)}\n`);
    // write 后主动失效缓存：下一次 read 通过 stat 看到新 mtimeMs 才会刷新；
    // 直接清空让"刚写入立刻读"也走完整磁盘 read 路径，确保拿到的就是写入后的字节序列。
    this.cachedStore = null;
    this.cachedStat = null;
  }
}
