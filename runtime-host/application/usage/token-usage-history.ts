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
    const results: TokenUsageHistoryEntry[] = [];

    for (const file of files) {
      if (results.length >= maxEntries) break;
      try {
        const content = await this.deps.fileSystem.readTextFile(file.filePath);
        const entries = parseUsageEntriesFromJsonl(content, {
          sessionId: file.sessionId,
          agentId: file.agentId,
        }, Number.isFinite(maxEntries) ? maxEntries - results.length : undefined);
        results.push(...entries);
      } catch {
        // Skip malformed transcript files.
      }
    }

    results.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
    return Number.isFinite(maxEntries) ? results.slice(0, maxEntries) : results;
  }
}
