import { execFile } from 'node:child_process';
import { access, copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';

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
  platform: NodeJS.Platform;
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
  now?: Date;
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

async function pathExists(pathname: string): Promise<boolean> {
  try {
    await access(pathname);
    return true;
  } catch {
    return false;
  }
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

function isRecentFile(stats: Stats, cutoffMs: number): boolean {
  return stats.mtimeMs >= cutoffMs;
}

async function walkFilesRecursively(
  rootDir: string,
  visit: (filePath: string, fileName: string, fileStats: Stats) => Promise<void>,
): Promise<void> {
  let entries: Array<import('node:fs').Dirent>;
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      await walkFilesRecursively(fullPath, visit);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }

    let fileStats: Stats;
    try {
      fileStats = await stat(fullPath);
    } catch {
      continue;
    }
    await visit(fullPath, entry.name, fileStats);
  }
}

async function readAndMaskJsonFile(filePath: string): Promise<string> {
  const raw = await readFile(filePath, 'utf8');
  try {
    const parsed = JSON.parse(raw) as unknown;
    const masked = sanitizeStructuredValue(parsed);
    return `${JSON.stringify(masked, null, 2)}\n`;
  } catch {
    return maskStringValue(raw, true);
  }
}

async function copyDiagnosticsEntryToStaging(
  stagingDir: string,
  entry: DiagnosticsBundleEntry,
): Promise<void> {
  const destinationPath = path.join(stagingDir, entry.destinationPath);
  await mkdir(path.dirname(destinationPath), { recursive: true });

  if (entry.redactJson) {
    const maskedContent = await readAndMaskJsonFile(entry.sourcePath);
    await writeFile(destinationPath, maskedContent, 'utf8');
    return;
  }

  await copyFile(entry.sourcePath, destinationPath);
}

function formatBundleTimestamp(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

function execFileAsync(command: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd,
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          const details = `${stderr || ''}\n${stdout || ''}`.trim();
          reject(new Error(details ? `${error.message}\n${details}` : error.message));
          return;
        }
        resolve();
      },
    );
  });
}

function escapePowerShellLiteral(input: string): string {
  return input.replace(/'/g, "''");
}

async function compressDiagnosticsStagingDir(stagingDir: string, outputZipPath: string): Promise<void> {
  await rm(outputZipPath, { force: true });

  if (process.platform === 'win32') {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `Compress-Archive -Path '${escapePowerShellLiteral(path.join(stagingDir, '*'))}' -DestinationPath '${escapePowerShellLiteral(outputZipPath)}' -Force`,
    ].join('; ');
    await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script,
    ]);
    return;
  }

  await execFileAsync('zip', ['-qr', outputZipPath, '.'], stagingDir);
}

export async function collectDiagnosticsBundle(input: CollectDiagnosticsBundleInput): Promise<DiagnosticsBundleResult> {
  const now = input.now ?? new Date();
  const generatedAt = now.toISOString();
  const cutoffMs = now.getTime() - (input.recentWindowMs ?? DEFAULT_RECENT_WINDOW_MS);
  const bundleRootDir = path.join(input.userDataDir, 'diagnostics-bundles');
  const bundleStamp = formatBundleTimestamp(now);
  const stagingDir = path.join(bundleRootDir, `staging-${bundleStamp}-${process.pid}`);
  const outputZipPath = path.join(bundleRootDir, `matchaclaw-diagnostics-${bundleStamp}.zip`);

  const counts = createEmptyCounts();
  const entryMap = new Map<string, DiagnosticsBundleEntry>();

  const userDataLogsDir = path.join(input.userDataDir, 'logs');
  await walkFilesRecursively(userDataLogsDir, async (filePath, _fileName, fileStats) => {
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
  await walkFilesRecursively(openclawLogsDir, async (filePath, _fileName, fileStats) => {
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
  let agentEntries: Array<import('node:fs').Dirent> = [];
  try {
    agentEntries = await readdir(agentsDir, { withFileTypes: true });
  } catch {
    agentEntries = [];
  }
  for (const agentEntry of agentEntries) {
    if (!agentEntry.isDirectory()) {
      continue;
    }
    const sessionsDir = path.join(agentsDir, agentEntry.name, 'sessions');
    const sessionsIndexPath = path.join(sessionsDir, 'sessions.json');
    if (await pathExists(sessionsIndexPath)) {
      counts.sessionIndexes += 1;
      addDiagnosticsEntry(entryMap, {
        sourcePath: sessionsIndexPath,
        destinationPath: path.join('openclaw', path.relative(input.openclawConfigDir, sessionsIndexPath)),
        redactJson: false,
      });
    }

    await walkFilesRecursively(sessionsDir, async (filePath, fileName, fileStats) => {
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
  await walkFilesRecursively(workspaceDir, async (filePath, fileName) => {
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
  await walkFilesRecursively(subagentsWorkspaceDir, async (filePath, fileName) => {
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
  let extensionEntries: Array<import('node:fs').Dirent> = [];
  try {
    extensionEntries = await readdir(extensionsDir, { withFileTypes: true });
  } catch {
    extensionEntries = [];
  }
  for (const extensionEntry of extensionEntries) {
    if (!extensionEntry.isDirectory()) {
      continue;
    }
    const manifestPath = path.join(extensionsDir, extensionEntry.name, 'openclaw.plugin.json');
    if (!(await pathExists(manifestPath))) {
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
  if (await pathExists(settingsPath)) {
    counts.settingsJson += 1;
    addDiagnosticsEntry(entryMap, {
      sourcePath: settingsPath,
      destinationPath: path.join('userdata', 'settings.json'),
      redactJson: true,
    });
  }

  const openclawConfigPath = path.join(input.openclawConfigDir, 'openclaw.json');
  if (await pathExists(openclawConfigPath)) {
    counts.openclawJson += 1;
    addDiagnosticsEntry(entryMap, {
      sourcePath: openclawConfigPath,
      destinationPath: path.join('openclaw', 'openclaw.json'),
      redactJson: true,
    });
  }

  const selectedEntries = Array.from(entryMap.values());
  await mkdir(bundleRootDir, { recursive: true });
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });

  try {
    for (const entry of selectedEntries) {
      await copyDiagnosticsEntryToStaging(stagingDir, entry);
    }

    const diagnosticsPayload = sanitizeStructuredValue({
      generatedAt,
      app: input.appInfo,
      runtime: {
        userDataDir: input.userDataDir,
        openclawConfigDir: input.openclawConfigDir,
        cutoffIso: new Date(cutoffMs).toISOString(),
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
    await writeFile(path.join(stagingDir, 'diagnostics.json'), `${JSON.stringify(diagnosticsPayload, null, 2)}\n`, 'utf8');

    const compressor = input.compressor ?? compressDiagnosticsStagingDir;
    await compressor(stagingDir, outputZipPath);
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }

  return {
    zipPath: outputZipPath,
    generatedAt,
    fileCount: selectedEntries.length + 1,
    counts,
  };
}
