import path from 'node:path';
import type { RuntimeFileStat, RuntimeFileSystemPort } from '../../../common/runtime-ports';
import type {
  DiagnosticsRuntimeBundleEntry,
  DiagnosticsRuntimeBundleLayoutPort,
} from '../../../support/diagnostics-bundle';
import type {
  TokenUsageSessionTranscriptFile,
  TokenUsageTranscriptLayoutPort,
} from '../../../usage/token-usage-history';

const WORKSPACE_FILE_WHITELIST = new Set(['AGENTS.md', 'SOUL.md', 'TOOLS.md', 'IDENTITY.md', 'USER.md']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isRecentFile(stats: RuntimeFileStat, cutoffMs: number): boolean {
  return stats.mtimeMs >= cutoffMs;
}

async function walkFilesRecursively(
  fileSystem: RuntimeFileSystemPort,
  rootDir: string,
  visit: (filePath: string, fileName: string, fileStats: RuntimeFileStat) => Promise<void>,
): Promise<void> {
  let entries: Awaited<ReturnType<RuntimeFileSystemPort['listDirectory']>>;
  try {
    entries = await fileSystem.listDirectory(rootDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory) {
      await walkFilesRecursively(fileSystem, fullPath, visit);
      continue;
    }
    if (!entry.isFile) {
      continue;
    }

    let fileStats: RuntimeFileStat;
    try {
      fileStats = await fileSystem.stat(fullPath);
    } catch {
      continue;
    }
    await visit(fullPath, entry.name, fileStats);
  }
}

function runtimeDestinationPath(runtimeDataRootDir: string, filePath: string): string {
  return path.join('runtime', path.relative(runtimeDataRootDir, filePath));
}

function extractSessionIdFromTranscriptFileName(fileName: string): string | undefined {
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

async function listConfiguredAgentIds(
  runtimeDataRootDir: string,
  fileSystem: RuntimeFileSystemPort,
): Promise<string[]> {
  const configPath = path.join(runtimeDataRootDir, 'openclaw.json');
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

async function listAgentIdsWithSessionDirs(
  runtimeDataRootDir: string,
  fileSystem: RuntimeFileSystemPort,
): Promise<string[]> {
  const agentIds = new Set<string>();
  const agentsDir = path.join(runtimeDataRootDir, 'agents');
  for (const agentId of await listConfiguredAgentIds(runtimeDataRootDir, fileSystem)) {
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
    return [...agentIds];
  }

  return [...agentIds];
}

export class OpenClawRuntimeDataLayout implements DiagnosticsRuntimeBundleLayoutPort, TokenUsageTranscriptLayoutPort {
  async listEntries(input: {
    runtimeDataRootDir: string;
    cutoffMs: number;
    fileSystem: RuntimeFileSystemPort;
  }): Promise<DiagnosticsRuntimeBundleEntry[]> {
    const entries: DiagnosticsRuntimeBundleEntry[] = [];
    await this.collectRuntimeLogs(input, entries);
    await this.collectSessionFiles(input, entries);
    await this.collectWorkspaceFiles(input, entries);
    await this.collectPluginManifests(input, entries);
    await this.collectRuntimeConfig(input, entries);
    return entries;
  }

  async listSessionTranscriptFiles(input: {
    runtimeDataRootDir: string;
    fileSystem: RuntimeFileSystemPort;
  }): Promise<TokenUsageSessionTranscriptFile[]> {
    const files: TokenUsageSessionTranscriptFile[] = [];
    const agentsDir = path.join(input.runtimeDataRootDir, 'agents');
    for (const agentId of await listAgentIdsWithSessionDirs(input.runtimeDataRootDir, input.fileSystem)) {
      const sessionsDir = path.join(agentsDir, agentId, 'sessions');
      let sessionEntries: Awaited<ReturnType<RuntimeFileSystemPort['listDirectory']>>;
      try {
        sessionEntries = await input.fileSystem.listDirectory(sessionsDir);
      } catch {
        continue;
      }

      for (const sessionEntry of sessionEntries) {
        if (!sessionEntry.isFile) {
          continue;
        }
        const sessionId = extractSessionIdFromTranscriptFileName(sessionEntry.name);
        if (!sessionId) {
          continue;
        }
        const filePath = path.join(sessionsDir, sessionEntry.name);
        try {
          const fileStat = await input.fileSystem.stat(filePath);
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
    }

    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return files;
  }

  private async collectRuntimeLogs(
    input: { runtimeDataRootDir: string; cutoffMs: number; fileSystem: RuntimeFileSystemPort },
    entries: DiagnosticsRuntimeBundleEntry[],
  ): Promise<void> {
    const logsDir = path.join(input.runtimeDataRootDir, 'logs');
    await walkFilesRecursively(input.fileSystem, logsDir, async (filePath, _fileName, fileStats) => {
      if (!isRecentFile(fileStats, input.cutoffMs)) {
        return;
      }
      entries.push({
        sourcePath: filePath,
        destinationPath: runtimeDestinationPath(input.runtimeDataRootDir, filePath),
        kind: 'runtimeLog',
        redactJson: false,
      });
    });
  }

  private async collectSessionFiles(
    input: { runtimeDataRootDir: string; cutoffMs: number; fileSystem: RuntimeFileSystemPort },
    entries: DiagnosticsRuntimeBundleEntry[],
  ): Promise<void> {
    const agentsDir = path.join(input.runtimeDataRootDir, 'agents');
    for (const agentId of await listAgentIdsWithSessionDirs(input.runtimeDataRootDir, input.fileSystem)) {
      const sessionsDir = path.join(agentsDir, agentId, 'sessions');
      const sessionsIndexPath = path.join(sessionsDir, 'sessions.json');
      if (await input.fileSystem.exists(sessionsIndexPath)) {
        entries.push({
          sourcePath: sessionsIndexPath,
          destinationPath: runtimeDestinationPath(input.runtimeDataRootDir, sessionsIndexPath),
          kind: 'sessionIndex',
          redactJson: false,
        });
      }

      await walkFilesRecursively(input.fileSystem, sessionsDir, async (filePath, fileName, fileStats) => {
        if (!fileName.endsWith('.jsonl')) {
          return;
        }
        if (!isRecentFile(fileStats, input.cutoffMs)) {
          return;
        }
        entries.push({
          sourcePath: filePath,
          destinationPath: runtimeDestinationPath(input.runtimeDataRootDir, filePath),
          kind: 'sessionJsonl',
          redactJson: false,
        });
      });
    }
  }

  private async collectWorkspaceFiles(
    input: { runtimeDataRootDir: string; fileSystem: RuntimeFileSystemPort },
    entries: DiagnosticsRuntimeBundleEntry[],
  ): Promise<void> {
    const workspaceDir = path.join(input.runtimeDataRootDir, 'workspace');
    await walkFilesRecursively(input.fileSystem, workspaceDir, async (filePath, fileName) => {
      if (!WORKSPACE_FILE_WHITELIST.has(fileName)) {
        return;
      }
      entries.push({
        sourcePath: filePath,
        destinationPath: runtimeDestinationPath(input.runtimeDataRootDir, filePath),
        kind: 'workspaceFile',
        redactJson: false,
      });
    });

    const subagentsWorkspaceDir = path.join(input.runtimeDataRootDir, 'workspace-subagents');
    await walkFilesRecursively(input.fileSystem, subagentsWorkspaceDir, async (filePath, fileName) => {
      if (!WORKSPACE_FILE_WHITELIST.has(fileName)) {
        return;
      }
      entries.push({
        sourcePath: filePath,
        destinationPath: runtimeDestinationPath(input.runtimeDataRootDir, filePath),
        kind: 'workspaceSubagentFile',
        redactJson: false,
      });
    });
  }

  private async collectPluginManifests(
    input: { runtimeDataRootDir: string; fileSystem: RuntimeFileSystemPort },
    entries: DiagnosticsRuntimeBundleEntry[],
  ): Promise<void> {
    const extensionsDir = path.join(input.runtimeDataRootDir, 'extensions');
    let extensionEntries: Awaited<ReturnType<RuntimeFileSystemPort['listDirectory']>>;
    try {
      extensionEntries = await input.fileSystem.listDirectory(extensionsDir);
    } catch {
      return;
    }
    for (const extensionEntry of extensionEntries) {
      if (!extensionEntry.isDirectory) {
        continue;
      }
      const manifestPath = path.join(extensionsDir, extensionEntry.name, 'openclaw.plugin.json');
      if (!(await input.fileSystem.exists(manifestPath))) {
        continue;
      }
      entries.push({
        sourcePath: manifestPath,
        destinationPath: runtimeDestinationPath(input.runtimeDataRootDir, manifestPath),
        kind: 'pluginManifest',
        redactJson: false,
      });
    }
  }

  private async collectRuntimeConfig(
    input: { runtimeDataRootDir: string; fileSystem: RuntimeFileSystemPort },
    entries: DiagnosticsRuntimeBundleEntry[],
  ): Promise<void> {
    const configPath = path.join(input.runtimeDataRootDir, 'openclaw.json');
    if (!(await input.fileSystem.exists(configPath))) {
      return;
    }
    entries.push({
      sourcePath: configPath,
      destinationPath: path.join('runtime', 'openclaw.json'),
      kind: 'runtimeConfig',
      redactJson: true,
    });
  }
}
