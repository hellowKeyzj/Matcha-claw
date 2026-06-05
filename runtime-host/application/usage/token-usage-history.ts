import type { RuntimeFileSystemPort } from '../common/runtime-ports';
import type { TokenUsageHistoryEntry } from './token-usage-parser';
import type { TokenUsageHistoryWorkflow } from '../workflows/usage/token-usage-history-workflow';

export function extractSessionIdFromTranscriptFileName(fileName: string): string | undefined {
  if (fileName.endsWith('.deleted.jsonl') || fileName.includes('.deleted.jsonl.reset.')) {
    return undefined;
  }
  if (!fileName.endsWith('.jsonl') && !fileName.includes('.jsonl.reset.')) {
    return undefined;
  }
  return fileName
    .replace(/\.reset\..+$/, '')
    .replace(/\.jsonl$/, '');
}

export interface TokenUsageSessionTranscriptFile {
  filePath: string;
  sessionId: string;
  agentId: string;
  mtimeMs: number;
}

export interface TokenUsageTranscriptLayoutPort {
  listSessionTranscriptFiles(input: {
    runtimeDataRootDir: string;
    fileSystem: RuntimeFileSystemPort;
  }): Promise<TokenUsageSessionTranscriptFile[]>;
}

export interface TokenUsageHistoryQueryOptions {
  limit?: number;
}

export interface TokenUsageRuntimeDataPort {
  getRuntimeDataRootDir(): string;
}

export interface TokenUsageHistoryRepositoryDeps {
  runtimeData: TokenUsageRuntimeDataPort;
  fileSystem: RuntimeFileSystemPort;
  transcriptLayout: TokenUsageTranscriptLayoutPort;
}

export class TokenUsageHistoryRepository {
  constructor(private readonly historyWorkflow: Pick<TokenUsageHistoryWorkflow,
    | 'recent'
    | 'refreshCache'
    | 'isReady'
    | 'scanRecent'
  >) {}

  recent(options: TokenUsageHistoryQueryOptions = {}): TokenUsageHistoryEntry[] {
    return this.historyWorkflow.recent(options);
  }

  async refreshCache(options: TokenUsageHistoryQueryOptions = {}): Promise<void> {
    await this.historyWorkflow.refreshCache(options);
  }

  isReady(): boolean {
    return this.historyWorkflow.isReady();
  }

  async scanRecent(options: TokenUsageHistoryQueryOptions = {}): Promise<TokenUsageHistoryEntry[]> {
    return await this.historyWorkflow.scanRecent(options);
  }
}
