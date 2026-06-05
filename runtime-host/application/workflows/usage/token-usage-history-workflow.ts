import type { RuntimeFileSystemPort } from '../../common/runtime-ports';
import { parseUsageEntriesFromJsonl, type TokenUsageHistoryEntry } from '../../usage/token-usage-parser';
import type { TokenUsageHistoryQueryOptions, TokenUsageRuntimeDataPort, TokenUsageTranscriptLayoutPort } from '../../usage/token-usage-history';

export interface TokenUsageHistoryWorkflowDeps {
  runtimeData: TokenUsageRuntimeDataPort;
  fileSystem: RuntimeFileSystemPort;
  transcriptLayout: TokenUsageTranscriptLayoutPort;
}

export class TokenUsageHistoryWorkflow {
  private cachedEntries: TokenUsageHistoryEntry[] = [];
  private cacheReady = false;
  private readonly fileCache = new Map<string, {
    readonly size: number;
    readonly mtimeMs: number;
    readonly entries: TokenUsageHistoryEntry[];
  }>();

  constructor(private readonly deps: TokenUsageHistoryWorkflowDeps) {}

  recent(options: TokenUsageHistoryQueryOptions = {}): TokenUsageHistoryEntry[] {
    const maxEntries = normalizeLimit(options.limit);
    if (maxEntries === 0) {
      return [];
    }

    return Number.isFinite(maxEntries)
      ? this.cachedEntries.slice(0, maxEntries)
      : [...this.cachedEntries];
  }

  async refreshCache(options: TokenUsageHistoryQueryOptions = {}): Promise<void> {
    this.cachedEntries = await this.scanRecent(options);
    this.cacheReady = true;
  }

  isReady(): boolean {
    return this.cacheReady;
  }

  async scanRecent(options: TokenUsageHistoryQueryOptions = {}): Promise<TokenUsageHistoryEntry[]> {
    const maxEntries = normalizeLimit(options.limit);
    if (maxEntries === 0) {
      return [];
    }

    const runtimeDataRootDir = this.deps.runtimeData.getRuntimeDataRootDir();
    const files = await this.deps.transcriptLayout.listSessionTranscriptFiles({
      runtimeDataRootDir,
      fileSystem: this.deps.fileSystem,
    });
    const presentFilePaths = new Set<string>(files.map((file) => file.filePath));
    const results: TokenUsageHistoryEntry[] = [];

    for (const file of files) {
      if (results.length >= maxEntries) break;
      try {
        const stat = await this.deps.fileSystem.stat(file.filePath);
        const cached = this.fileCache.get(file.filePath);
        let entries: TokenUsageHistoryEntry[];
        if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
          entries = cached.entries;
        } else {
          const content = await this.deps.fileSystem.readTextFile(file.filePath);
          entries = parseUsageEntriesFromJsonl(content, {
            sessionId: file.sessionId,
            agentId: file.agentId,
          });
          this.fileCache.set(file.filePath, {
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            entries,
          });
        }
        const remaining = Number.isFinite(maxEntries) ? maxEntries - results.length : entries.length;
        if (remaining >= entries.length) {
          results.push(...entries);
        } else {
          results.push(...entries.slice(0, remaining));
        }
      } catch {
        this.fileCache.delete(file.filePath);
      }
    }

    for (const cachedPath of [...this.fileCache.keys()]) {
      if (!presentFilePaths.has(cachedPath)) {
        this.fileCache.delete(cachedPath);
      }
    }

    results.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
    return Number.isFinite(maxEntries) ? results.slice(0, maxEntries) : results;
  }
}

function normalizeLimit(limit: unknown): number {
  return typeof limit === 'number' && Number.isFinite(limit)
    ? Math.max(Math.floor(limit), 0)
    : Number.POSITIVE_INFINITY;
}
