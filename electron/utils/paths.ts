/**
 * Path Utilities
 * Cross-platform path resolution helpers
 */
import { app } from 'electron';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { existsSync, mkdirSync, realpathSync } from 'fs';

export {
  quoteForCmd,
  needsWinShell,
  prepareWinSpawn,
  normalizeNodeRequirePathForNodeOptions,
  appendNodeRequireToNodeOptions,
} from './win-shell';

/**
 * Expand ~ to home directory
 */
export function expandPath(path: string): string {
  if (path.startsWith('~')) {
    return path.replace('~', homedir());
  }
  return path;
}

/**
 * Get the OpenClaw-owned config/state directory.
 */
export function getOpenClawConfigDir(): string {
  const configuredDirectory = process.env.OPENCLAW_CONFIG_DIR?.trim();
  if (configuredDirectory) {
    return resolve(expandPath(configuredDirectory));
  }
  const e2eUserDataDir = process.env.MATCHACLAW_E2E_USER_DATA_DIR?.trim();
  if (process.env.MATCHACLAW_E2E === '1' && e2eUserDataDir) {
    return resolve(join(e2eUserDataDir, 'openclaw'));
  }
  return resolve(join(homedir(), '.openclaw'));
}

/**
 * Get the MatchaClaw-owned runtime-host state directory.
 */
export function getRuntimeHostStateDir(): string {
  return join(getUserDataRoot(), 'runtime-host');
}

function getUserDataRoot(): string {
  const e2eUserDataDir = process.env.MATCHACLAW_E2E_USER_DATA_DIR?.trim();
  if (process.env.MATCHACLAW_E2E === '1' && e2eUserDataDir) {
    return e2eUserDataDir;
  }
  return app.getPath('userData');
}

/**
 * Get MatchaClaw config directory
 */
export function getMatchaClawConfigDir(): string {
  return join(homedir(), '.matchaclaw');
}

/**
 * Get MatchaClaw logs directory
 */
export function getLogsDir(): string {
  return join(app.getPath('userData'), 'logs');
}

/**
 * Get MatchaClaw data directory
 */
export function getDataDir(): string {
  return app.getPath('userData');
}

/**
 * Get Electron Main-owned runtime-neutral attachment staging directory.
 */
export function getAttachmentStagingDir(): string {
  return join(getDataDir(), 'attachments');
}

/**
 * Ensure directory exists
 */
export function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Get resources directory (for bundled assets)
 */
export function getResourcesDir(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'resources');
  }
  return join(__dirname, '../../resources');
}

/**
 * Get preload script path
 */
export function getPreloadPath(): string {
  return join(__dirname, '../preload/index.js');
}

/**
 * Get OpenClaw package directory
 * - Production (packaged): from resources/openclaw (copied by electron-builder extraResources)
 * - Development: from node_modules/openclaw
 */
export function getOpenClawDir(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'openclaw');
  }
  // Development: use node_modules/openclaw
  return join(__dirname, '../../node_modules/openclaw');
}

/**
 * Get OpenClaw package directory resolved to a real path.
 * Useful when consumers need deterministic module resolution under pnpm symlinks.
 */
export function getOpenClawResolvedDir(): string {
  const dir = getOpenClawDir();
  if (!existsSync(dir)) {
    return dir;
  }
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

/**
 * Get OpenClaw entry script path (openclaw.mjs)
 */
export function getOpenClawEntryPath(): string {
  return join(getOpenClawDir(), 'openclaw.mjs');
}

/**
 * Get ClawHub CLI entry script path (clawdhub.js)
 */
export function getClawHubCliEntryPath(): string {
  return join(app.getAppPath(), 'node_modules', 'clawhub', 'bin', 'clawdhub.js');
}

/**
 * Get ClawHub CLI binary path (node_modules/.bin)
 */
export function getClawHubCliBinPath(): string {
  const binName = process.platform === 'win32' ? 'clawhub.cmd' : 'clawhub';
  return join(app.getAppPath(), 'node_modules', '.bin', binName);
}

/**
 * Check if OpenClaw package exists
 */
export function isOpenClawPresent(): boolean {
  const dir = getOpenClawDir();
  const pkgJsonPath = join(dir, 'package.json');
  return existsSync(dir) && existsSync(pkgJsonPath);
}
