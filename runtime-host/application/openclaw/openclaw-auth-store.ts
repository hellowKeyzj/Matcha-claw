import { constants, type Dirent } from 'fs';
import { access, mkdir, readFile, readdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { createRuntimeLogger } from '../../shared/logger';

const logger = createRuntimeLogger('openclaw-auth-store');

export const AUTH_STORE_VERSION = 1;
export const AUTH_PROFILE_FILENAME = 'auth-profiles.json';
export const OPENCLAW_CONFIG_PATH = join(homedir(), '.openclaw', 'openclaw.json');

export interface AuthProfileEntry {
  type: 'api_key';
  provider: string;
  key: string;
}

export interface OAuthProfileEntry {
  type: 'oauth';
  provider: string;
  access: string;
  refresh: string;
  expires: number;
  email?: string;
  projectId?: string;
}

export interface AuthProfilesStore {
  version: number;
  profiles: Record<string, AuthProfileEntry | OAuthProfileEntry>;
  order?: Record<string, string[]>;
  lastGood?: Record<string, string>;
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(dirPath: string): Promise<void> {
  if (!(await fileExists(dirPath))) {
    await mkdir(dirPath, { recursive: true });
  }
}

export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    if (!(await fileExists(filePath))) {
      return null;
    }
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await ensureDir(join(filePath, '..'));
  await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

export function getAuthProfilesPath(agentId = 'main'): string {
  return join(homedir(), '.openclaw', 'agents', agentId, 'agent', AUTH_PROFILE_FILENAME);
}

export async function readAuthProfiles(agentId = 'main'): Promise<AuthProfilesStore> {
  const filePath = getAuthProfilesPath(agentId);
  try {
    const data = await readJsonFile<AuthProfilesStore>(filePath);
    if (data?.version && data.profiles && typeof data.profiles === 'object') {
      return data;
    }
  } catch (error) {
    logger.warn('Failed to read auth-profiles.json, creating fresh store:', error);
  }
  return { version: AUTH_STORE_VERSION, profiles: {} };
}

export async function writeAuthProfiles(store: AuthProfilesStore, agentId = 'main'): Promise<void> {
  await writeJsonFile(getAuthProfilesPath(agentId), store);
}

export async function discoverAgentIds(): Promise<string[]> {
  const agentsDir = join(homedir(), '.openclaw', 'agents');
  try {
    if (!(await fileExists(agentsDir))) {
      return ['main'];
    }
    const entries: Dirent[] = await readdir(agentsDir, { withFileTypes: true });
    const ids: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory() && await fileExists(join(agentsDir, entry.name, 'agent'))) {
        ids.push(entry.name);
      }
    }
    return ids.length > 0 ? ids : ['main'];
  } catch {
    return ['main'];
  }
}

export async function readOpenClawJson(): Promise<Record<string, unknown>> {
  return (await readJsonFile<Record<string, unknown>>(OPENCLAW_CONFIG_PATH)) ?? {};
}

export async function writeOpenClawJson(config: Record<string, unknown>): Promise<void> {
  const commands = (
    config.commands && typeof config.commands === 'object'
      ? { ...(config.commands as Record<string, unknown>) }
      : {}
  ) as Record<string, unknown>;
  commands.restart = true;
  config.commands = commands;
  await writeJsonFile(OPENCLAW_CONFIG_PATH, config);
}
