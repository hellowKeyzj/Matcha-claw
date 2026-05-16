import { join } from 'node:path';
import type { RuntimeFileSystemPort } from '../common/runtime-ports';
import type { OpenClawConfigRepositoryPort } from '../openclaw/openclaw-config-repository';
import { parseUsageEntriesFromJsonl, type TokenUsageHistoryEntry } from './token-usage-parser';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function listConfiguredAgentIds(
  openclawConfigDir: string,
  fileSystem: RuntimeFileSystemPort,
): Promise<string[]> {
  const configPath = join(openclawConfigDir, 'openclaw.json');
  const normalizedIds = new Set<string>();
  try {
    const raw = await fileSystem.readTextFile(configPath);
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return [];
    }
    const agents = isRecord(parsed.agents) ? parsed.agents : {};
    const list = Array.isArray(agents.list) ? agents.list : [];
    for (const item of list) {
      if (!isRecord(item)) {
        continue;
      }
      const id = typeof item.id === 'string' ? item.id.trim() : '';
      if (id) {
        normalizedIds.add(id);
      }
    }
    return [...normalizedIds];
  } catch {
    return [];
  }
}

export function extractSessionIdFromTranscriptFileName(fileName: string): string | undefined {
  if (!fileName.endsWith('.jsonl') && !fileName.includes('.jsonl.reset.')) {
    return undefined;
  }
  return fileName
    .replace(/\.reset\..+$/, '')
    .replace(/\.deleted\.jsonl$/, '')
    .replace(/\.jsonl$/, '');
}

async function listAgentIdsWithSessionDirs(
  openclawConfigDir: string,
  fileSystem: RuntimeFileSystemPort,
): Promise<string[]> {
  const agentIds = new Set<string>();
  const agentsDir = join(openclawConfigDir, 'agents');
  for (const agentId of await listConfiguredAgentIds(openclawConfigDir, fileSystem)) {
    const normalized = agentId.trim();
    if (normalized) {
      agentIds.add(normalized);
    }
  }

  try {
    const agentEntries = await fileSystem.listDirectory(agentsDir);
    for (const entry of agentEntries) {
      if (!entry.isDirectory) {
        continue;
      }
      const normalized = entry.name.trim();
      if (normalized) {
        agentIds.add(normalized);
      }
    }
  } catch {
    // Ignore disk discovery failures and return configured IDs only.
  }

  return [...agentIds];
}

async function listRecentSessionFiles(
  openclawConfigDir: string,
  fileSystem: RuntimeFileSystemPort,
): Promise<Array<{ filePath: string; sessionId: string; agentId: string; mtimeMs: number }>> {
  const openclawDir = openclawConfigDir;
  const agentsDir = join(openclawDir, 'agents');
  try {
    const agentEntries = await listAgentIdsWithSessionDirs(openclawDir, fileSystem);
    const files: Array<{ filePath: string; sessionId: string; agentId: string; mtimeMs: number }> = [];

    for (const agentId of agentEntries) {
      const sessionsDir = join(agentsDir, agentId, 'sessions');
      try {
        const sessionEntries = await fileSystem.listDirectory(sessionsDir);

        for (const sessionEntry of sessionEntries) {
          if (!sessionEntry.isFile) {
            continue;
          }
          const fileName = sessionEntry.name;
          const sessionId = extractSessionIdFromTranscriptFileName(fileName);
          if (!sessionId) {
            continue;
          }
          const filePath = join(sessionsDir, fileName);
          try {
            const fileStat = await fileSystem.stat(filePath);
            files.push({
              filePath,
              sessionId,
              agentId,
              mtimeMs: fileStat.mtimeMs,
            });
          } catch {
            continue;
          }
        }
      } catch {
        continue;
      }
    }

    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return files;
  } catch {
    return [];
  }
}

export interface TokenUsageHistoryQueryOptions {
  limit?: number;
}

export interface TokenUsageHistoryRepositoryDeps {
  configRepository: OpenClawConfigRepositoryPort;
  fileSystem: RuntimeFileSystemPort;
}

export class TokenUsageHistoryRepository {
  private cachedEntries: TokenUsageHistoryEntry[] = [];
  private cacheReady = false;
  // 按文件 path 缓存上次解析结果。下次扫描时，如果 stat 的 size + mtimeMs 与缓存一致，
  // 直接复用 entries，不再重新 readFile + JSON.parse 每一行。文件被删除（不再出现在 listRecentSessionFiles
  // 输出里）会在 reconcile 阶段从 fileCache 移除，避免内存无界增长。
  private readonly fileCache = new Map<string, {
    readonly size: number;
    readonly mtimeMs: number;
    readonly entries: TokenUsageHistoryEntry[];
  }>();

  constructor(private readonly deps: TokenUsageHistoryRepositoryDeps) {}

  recent(options: TokenUsageHistoryQueryOptions = {}): TokenUsageHistoryEntry[] {
    const maxEntries = typeof options.limit === 'number' && Number.isFinite(options.limit)
      ? Math.max(Math.floor(options.limit), 0)
      : Number.POSITIVE_INFINITY;
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
    const maxEntries = typeof options.limit === 'number' && Number.isFinite(options.limit)
      ? Math.max(Math.floor(options.limit), 0)
      : Number.POSITIVE_INFINITY;
    if (maxEntries === 0) {
      return [];
    }

    const openclawConfigDir = this.deps.configRepository.getConfigDir();
    const files = await listRecentSessionFiles(openclawConfigDir, this.deps.fileSystem);
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
        // 单文件解析失败仅丢弃该文件，不影响其他文件。文件已损坏时主动从缓存清掉，下次重读。
        this.fileCache.delete(file.filePath);
      }
    }

    // 文件已被删除（不在最新 listRecentSessionFiles 输出里）从缓存移除，避免长跑内存增长。
    for (const cachedPath of [...this.fileCache.keys()]) {
      if (!presentFilePaths.has(cachedPath)) {
        this.fileCache.delete(cachedPath);
      }
    }

    results.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
    return Number.isFinite(maxEntries) ? results.slice(0, maxEntries) : results;
  }
}
