import { existsSync, readFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function findWorkspaceRoot(startDir: string): string | null {
  let currentDir = resolve(startDir);
  while (true) {
    if (existsSync(join(currentDir, 'pnpm-workspace.yaml'))) {
      return currentDir;
    }
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

export function expandHomePath(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  if (value.startsWith('~')) {
    return value.replace('~', homedir());
  }
  return value;
}

export function getOpenClawDirPath(): string {
  const explicitDir = String(process.env.MATCHACLAW_OPENCLAW_DIR || '').trim();
  if (explicitDir) {
    return resolve(expandHomePath(explicitDir));
  }
  const packagedDir = typeof process.resourcesPath === 'string'
    ? join(process.resourcesPath, 'openclaw')
    : '';
  if (packagedDir && existsSync(join(packagedDir, 'package.json'))) {
    return resolve(packagedDir);
  }
  const workspaceRoot = findWorkspaceRoot(__dirname) || process.cwd();
  return resolve(join(workspaceRoot, 'node_modules/openclaw'));
}

export function getOpenClawStatus() {
  const dir = getOpenClawDirPath();
  const entryPath = join(dir, 'openclaw.mjs');
  const packagePath = join(dir, 'package.json');
  const distDir = join(dir, 'dist');
  const packageExists = existsSync(dir) && existsSync(packagePath);
  const isBuilt = existsSync(distDir);
  let version: string | undefined;
  if (packageExists) {
    try {
      const raw = readFileSync(packagePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (isRecord(parsed) && typeof parsed.version === 'string' && parsed.version.trim()) {
        version = parsed.version;
      }
    } catch {
      // ignore version read errors
    }
  }
  return {
    packageExists,
    isBuilt,
    entryPath,
    dir,
    ...(version ? { version } : {}),
  };
}

export function getOpenClawConfigDir(): string {
  const explicitConfigDir = String(process.env.OPENCLAW_CONFIG_DIR || '').trim();
  if (explicitConfigDir) {
    return resolve(expandHomePath(explicitConfigDir));
  }
  return resolve(join(homedir(), '.openclaw'));
}

export function getOpenClawConfigFilePath(): string {
  return join(getOpenClawConfigDir(), 'openclaw.json');
}

export function readOpenClawConfigJson(): Record<string, unknown> {
  const configPath = getOpenClawConfigFilePath();
  if (!existsSync(configPath)) {
    return {};
  }
  try {
    const raw = readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export async function writeOpenClawConfigJson(config: Record<string, unknown>): Promise<void> {
  const configDir = getOpenClawConfigDir();
  await fsPromises.mkdir(configDir, { recursive: true });
  await fsPromises.writeFile(getOpenClawConfigFilePath(), JSON.stringify(config, null, 2), 'utf8');
}

export function getRuntimeHostDataDir(): string {
  const explicit = String(process.env.MATCHACLAW_RUNTIME_HOST_DATA_DIR || '').trim();
  if (explicit) {
    return resolve(expandHomePath(explicit));
  }
  return getOpenClawConfigDir();
}

export function getRuntimeHostSettingsFilePath(): string {
  const explicit = String(process.env.MATCHACLAW_RUNTIME_HOST_SETTINGS_FILE || '').trim();
  if (explicit) {
    return resolve(expandHomePath(explicit));
  }
  return join(getRuntimeHostDataDir(), 'matchaclaw-settings.json');
}

export function getProviderStoreFilePath(): string {
  const explicit = String(process.env.MATCHACLAW_RUNTIME_HOST_PROVIDER_STORE_FILE || '').trim();
  if (explicit) {
    return resolve(expandHomePath(explicit));
  }
  return join(getRuntimeHostDataDir(), 'matchaclaw-provider-accounts.json');
}

export async function ensureParentDir(pathname: string): Promise<void> {
  await fsPromises.mkdir(dirname(pathname), { recursive: true });
}
