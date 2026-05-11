import path from 'node:path';
import type {
  RuntimeClockPort,
  RuntimeCommandExecutorPort,
  RuntimeFileStat,
  RuntimeFileSystemPort,
  RuntimePlatform,
} from '../common/runtime-ports';

const DEFAULT_RECENT_WINDOW_MS = 72 * 60 * 60 * 1000;
const WORKSPACE_FILE_WHITELIST = new Set(['AGENTS.md', 'SOUL.md', 'TOOLS.md', 'IDENTITY.md', 'USER.md']);

export interface DiagnosticsCounts {
  userDataLogs: number;
  openclawLogs: number;
  sessionIndexes: number;
  sessionJsonl: number;
  workspaceFiles: number;
  workspaceSubagentFiles: number;
  pluginManifests: number;
  settingsJson: number;
  openclawJson: number;
}

export interface DiagnosticsBundleResult {
  zipPath: string;
  generatedAt: string;
  fileCount: number;
  counts: DiagnosticsCounts;
}

interface DiagnosticsBundleEntry {
  sourcePath: string;
  destinationPath: string;
  redactJson: boolean;
}

interface DiagnosticsAppInfo {
  name: string;
  version: string;
  isPackaged: boolean;
  platform: RuntimePlatform;
  arch: string;
  electron?: string;
  node: string;
}

interface DiagnosticsGatewayInfo {
  status: unknown;
  runtimePaths?: unknown;
}

interface DiagnosticsLicenseInfo {
  gateSnapshot?: unknown;
}

export interface CollectDiagnosticsBundleInput {
  userDataDir: string;
  openclawConfigDir: string;
  appInfo: DiagnosticsAppInfo;
  gateway: DiagnosticsGatewayInfo;
  license?: DiagnosticsLicenseInfo;
  recentWindowMs?: number;
  processId?: number;
  platform?: RuntimePlatform;
  clock: RuntimeClockPort;
  fileSystem: RuntimeFileSystemPort;
  commandExecutor?: RuntimeCommandExecutorPort;
  compressor?: (stagingDir: string, outputZipPath: string) => Promise<void>;
}

type JsonRecord = Record<string, unknown>;

function createEmptyCounts(): DiagnosticsCounts {
  return {
    userDataLogs: 0,
    openclawLogs: 0,
    sessionIndexes: 0,
    sessionJsonl: 0,
    workspaceFiles: 0,
    workspaceSubagentFiles: 0,
    pluginManifests: 0,
    settingsJson: 0,
    openclawJson: 0,
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSensitiveKeyName(key?: string): boolean {
  if (!key) {
    return false;
  }
  const normalized = key.toLowerCase();
  return normalized.includes('token')
    || normalized.includes('secret')
    || normalized.includes('password')
    || normalized.includes('apikey')
    || normalized.includes('api_key')
    || normalized === 'key'
    || normalized.includes('authorization')
    || normalized.includes('cookie')
    || normalized.includes('proxy');
}

function maskStringValue(value: string, force = false): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }
  if (force) {
    return '***';
  }
  if (trimmed.length <= 6) {
    return '***';
  }
  return `${trimmed.slice(0, 2)}***${trimmed.slice(-2)}`;
}

export function sanitizeStructuredValue(value: unknown, parentKey?: string): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeStructuredValue(entry, parentKey));
  }

  if (isRecord(value)) {
    const result: JsonRecord = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = sanitizeStructuredValue(entry, key);
    }
    return result;
  }

  if (typeof value === 'string') {
    if (!isSensitiveKeyName(parentKey)) {
      return value;
    }
    return maskStringValue(value, true);
  }

  return value;
}

function normalizeBundleDestination(input: string): string {
  const normalized = input.replaceAll('\\', '/').replace(/^\/+/, '');
  return normalized;
}

function addDiagnosticsEntry(
  entryMap: Map<string, DiagnosticsBundleEntry>,
  entry: DiagnosticsBundleEntry,
): void {
  const destinationPath = normalizeBundleDestination(entry.destinationPath);
  if (!destinationPath) {
    return;
  }
  const mapKey = destinationPath.toLowerCase();
  entryMap.set(mapKey, {
    ...entry,
    destinationPath,
  });
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

async function readAndMaskJsonFile(
  fileSystem: RuntimeFileSystemPort,
  filePath: string,
): Promise<string> {
  const raw = await fileSystem.readTextFile(filePath);
  try {
    const parsed = JSON.parse(raw) as unknown;
    const masked = sanitizeStructuredValue(parsed);
    return `${JSON.stringify(masked, null, 2)}\n`;
  } catch {
    return maskStringValue(raw, true);
  }
}

async function copyDiagnosticsEntryToStaging(
  fileSystem: RuntimeFileSystemPort,
  stagingDir: string,
  entry: DiagnosticsBundleEntry,
): Promise<void> {
  const destinationPath = path.join(stagingDir, entry.destinationPath);
  await fileSystem.ensureDirectory(path.dirname(destinationPath));

  if (entry.redactJson) {
    const maskedContent = await readAndMaskJsonFile(fileSystem, entry.sourcePath);
    await fileSystem.writeTextFile(destinationPath, maskedContent);
    return;
  }

  await fileSystem.copyFile(entry.sourcePath, destinationPath);
}

function formatBundleTimestamp(isoTimestamp: string): string {
  const yyyy = isoTimestamp.slice(0, 4);
  const mm = isoTimestamp.slice(5, 7);
  const dd = isoTimestamp.slice(8, 10);
  const hh = isoTimestamp.slice(11, 13);
  const mi = isoTimestamp.slice(14, 16);
  const ss = isoTimestamp.slice(17, 19);
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

function escapePowerShellLiteral(input: string): string {
  return input.replace(/'/g, "''");
}

async function compressDiagnosticsStagingDir(
  fileSystem: RuntimeFileSystemPort,
  stagingDir: string,
  outputZipPath: string,
  platform: RuntimePlatform,
  commandExecutor: RuntimeCommandExecutorPort,
): Promise<void> {
  await fileSystem.removeFile(outputZipPath);

  if (platform === 'win32') {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `Compress-Archive -Path '${escapePowerShellLiteral(path.join(stagingDir, '*'))}' -DestinationPath '${escapePowerShellLiteral(outputZipPath)}' -Force`,
    ].join('; ');
    await commandExecutor.execFile('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script,
    ]);
    return;
  }

  await commandExecutor.execFile('zip', ['-qr', outputZipPath, '.'], {
    cwd: stagingDir,
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
}

export async function collectDiagnosticsBundle(input: CollectDiagnosticsBundleInput): Promise<DiagnosticsBundleResult> {
  const generatedAt = input.clock.nowIso();
  const nowMs = input.clock.nowMs();
  const cutoffMs = nowMs - (input.recentWindowMs ?? DEFAULT_RECENT_WINDOW_MS);
  const bundleRootDir = path.join(input.userDataDir, 'diagnostics-bundles');
  const bundleStamp = formatBundleTimestamp(generatedAt);
  const stagingInstanceId = typeof input.processId === 'number'
    ? String(input.processId)
    : `${nowMs}`;
  const stagingDir = path.join(bundleRootDir, `staging-${bundleStamp}-${stagingInstanceId}`);
  const outputZipPath = path.join(bundleRootDir, `matchaclaw-diagnostics-${bundleStamp}.zip`);

  const counts = createEmptyCounts();
  const entryMap = new Map<string, DiagnosticsBundleEntry>();
  const { fileSystem } = input;

  const userDataLogsDir = path.join(input.userDataDir, 'logs');
  await walkFilesRecursively(fileSystem, userDataLogsDir, async (filePath, _fileName, fileStats) => {
    if (!isRecentFile(fileStats, cutoffMs)) {
      return;
    }
    counts.userDataLogs += 1;
    addDiagnosticsEntry(entryMap, {
      sourcePath: filePath,
      destinationPath: path.join('userdata', path.relative(input.userDataDir, filePath)),
      redactJson: false,
    });
  });

  const openclawLogsDir = path.join(input.openclawConfigDir, 'logs');
  await walkFilesRecursively(fileSystem, openclawLogsDir, async (filePath, _fileName, fileStats) => {
    if (!isRecentFile(fileStats, cutoffMs)) {
      return;
    }
    counts.openclawLogs += 1;
    addDiagnosticsEntry(entryMap, {
      sourcePath: filePath,
      destinationPath: path.join('openclaw', path.relative(input.openclawConfigDir, filePath)),
      redactJson: false,
    });
  });

  const agentsDir = path.join(input.openclawConfigDir, 'agents');
  let agentEntries: Awaited<ReturnType<RuntimeFileSystemPort['listDirectory']>> = [];
  try {
    agentEntries = await fileSystem.listDirectory(agentsDir);
  } catch {
    // ignore
  }
  for (const agentEntry of agentEntries) {
    if (!agentEntry.isDirectory) {
      continue;
    }
    const sessionsDir = path.join(agentsDir, agentEntry.name, 'sessions');
    const sessionsIndexPath = path.join(sessionsDir, 'sessions.json');
    if (await fileSystem.exists(sessionsIndexPath)) {
      counts.sessionIndexes += 1;
      addDiagnosticsEntry(entryMap, {
        sourcePath: sessionsIndexPath,
        destinationPath: path.join('openclaw', path.relative(input.openclawConfigDir, sessionsIndexPath)),
        redactJson: false,
      });
    }

    await walkFilesRecursively(fileSystem, sessionsDir, async (filePath, fileName, fileStats) => {
      if (!fileName.endsWith('.jsonl')) {
        return;
      }
      if (!isRecentFile(fileStats, cutoffMs)) {
        return;
      }
      counts.sessionJsonl += 1;
      addDiagnosticsEntry(entryMap, {
        sourcePath: filePath,
        destinationPath: path.join('openclaw', path.relative(input.openclawConfigDir, filePath)),
        redactJson: false,
      });
    });
  }

  const workspaceDir = path.join(input.openclawConfigDir, 'workspace');
  await walkFilesRecursively(fileSystem, workspaceDir, async (filePath, fileName) => {
    if (!WORKSPACE_FILE_WHITELIST.has(fileName)) {
      return;
    }
    counts.workspaceFiles += 1;
    addDiagnosticsEntry(entryMap, {
      sourcePath: filePath,
      destinationPath: path.join('openclaw', path.relative(input.openclawConfigDir, filePath)),
      redactJson: false,
    });
  });

  const subagentsWorkspaceDir = path.join(input.openclawConfigDir, 'workspace-subagents');
  await walkFilesRecursively(fileSystem, subagentsWorkspaceDir, async (filePath, fileName) => {
    if (!WORKSPACE_FILE_WHITELIST.has(fileName)) {
      return;
    }
    counts.workspaceSubagentFiles += 1;
    addDiagnosticsEntry(entryMap, {
      sourcePath: filePath,
      destinationPath: path.join('openclaw', path.relative(input.openclawConfigDir, filePath)),
      redactJson: false,
    });
  });

  const extensionsDir = path.join(input.openclawConfigDir, 'extensions');
  let extensionEntries: Awaited<ReturnType<RuntimeFileSystemPort['listDirectory']>> = [];
  try {
    extensionEntries = await fileSystem.listDirectory(extensionsDir);
  } catch {
    // ignore
  }
  for (const extensionEntry of extensionEntries) {
    if (!extensionEntry.isDirectory) {
      continue;
    }
    const manifestPath = path.join(extensionsDir, extensionEntry.name, 'openclaw.plugin.json');
    if (!(await fileSystem.exists(manifestPath))) {
      continue;
    }
    counts.pluginManifests += 1;
    addDiagnosticsEntry(entryMap, {
      sourcePath: manifestPath,
      destinationPath: path.join('openclaw', path.relative(input.openclawConfigDir, manifestPath)),
      redactJson: false,
    });
  }

  const settingsPath = path.join(input.userDataDir, 'settings.json');
  if (await fileSystem.exists(settingsPath)) {
    counts.settingsJson += 1;
    addDiagnosticsEntry(entryMap, {
      sourcePath: settingsPath,
      destinationPath: path.join('userdata', 'settings.json'),
      redactJson: true,
    });
  }

  const openclawConfigPath = path.join(input.openclawConfigDir, 'openclaw.json');
  if (await fileSystem.exists(openclawConfigPath)) {
    counts.openclawJson += 1;
    addDiagnosticsEntry(entryMap, {
      sourcePath: openclawConfigPath,
      destinationPath: path.join('openclaw', 'openclaw.json'),
      redactJson: true,
    });
  }

  const selectedEntries = Array.from(entryMap.values());
  await fileSystem.ensureDirectory(bundleRootDir);
  await fileSystem.removeDirectory(stagingDir);
  await fileSystem.ensureDirectory(stagingDir);

  try {
    for (const entry of selectedEntries) {
      await copyDiagnosticsEntryToStaging(fileSystem, stagingDir, entry);
    }

    const diagnosticsPayload = sanitizeStructuredValue({
      generatedAt,
      app: input.appInfo,
      runtime: {
        userDataDir: input.userDataDir,
        openclawConfigDir: input.openclawConfigDir,
        cutoffIso: input.clock.toIsoString(cutoffMs),
      },
      gateway: {
        status: input.gateway.status,
        runtimePaths: input.gateway.runtimePaths,
      },
      license: {
        gateSnapshot: input.license?.gateSnapshot,
      },
      bundle: {
        fileCount: selectedEntries.length,
        counts,
      },
    });
    await fileSystem.writeTextFile(path.join(stagingDir, 'diagnostics.json'), `${JSON.stringify(diagnosticsPayload, null, 2)}\n`);

    const compressor = input.compressor ?? (async (sourceDir: string, targetZipPath: string) => {
      if (!input.commandExecutor) {
        throw new Error('Runtime command executor is required to collect diagnostics bundle');
      }
      await compressDiagnosticsStagingDir(
        fileSystem,
        sourceDir,
        targetZipPath,
        input.platform ?? input.appInfo.platform,
        input.commandExecutor,
      );
    });
    await compressor(stagingDir, outputZipPath);
  } finally {
    await fileSystem.removeDirectory(stagingDir);
  }

  return {
    zipPath: outputZipPath,
    generatedAt,
    fileCount: selectedEntries.length + 1,
    counts,
  };
}
