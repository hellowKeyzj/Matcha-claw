import { join } from 'path';
import type { RuntimeHostLogger } from '../../shared/logger';
import type { RuntimeFileSystemPort } from '../common/runtime-ports';
import type { OpenClawConfigRepositoryPort } from './openclaw-config-repository';

export const AUTH_STORE_VERSION = 1;
export const AUTH_PROFILE_FILENAME = 'auth-profiles.json';

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

export async function readJsonFile<T>(
  fileSystem: RuntimeFileSystemPort,
  filePath: string,
): Promise<T | null> {
  try {
    if (!(await fileSystem.exists(filePath))) {
      return null;
    }
    const raw = await fileSystem.readTextFile(filePath);
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function writeJsonFile(
  fileSystem: RuntimeFileSystemPort,
  filePath: string,
  data: unknown,
): Promise<void> {
  await fileSystem.ensureDirectory(join(filePath, '..'));
  await fileSystem.writeTextFile(filePath, JSON.stringify(data, null, 2));
}

export class OpenClawAuthRepository {
  constructor(
    private readonly configRepository: OpenClawConfigRepositoryPort,
    private readonly fileSystem: RuntimeFileSystemPort,
    private readonly logger: RuntimeHostLogger,
  ) {}

  getAuthProfilesPath(agentId = 'main'): string {
    return join(this.configRepository.getConfigDir(), 'agents', agentId, 'agent', AUTH_PROFILE_FILENAME);
  }

  async readAuthProfiles(agentId = 'main'): Promise<AuthProfilesStore> {
    const filePath = this.getAuthProfilesPath(agentId);
    try {
      const data = await readJsonFile<AuthProfilesStore>(this.fileSystem, filePath);
      if (data?.version && data.profiles && typeof data.profiles === 'object') {
        return data;
      }
    } catch (error) {
      this.logger.warn('Failed to read auth-profiles.json, creating fresh store:', error);
    }
    return { version: AUTH_STORE_VERSION, profiles: {} };
  }

  async writeAuthProfiles(store: AuthProfilesStore, agentId = 'main'): Promise<void> {
    await writeJsonFile(this.fileSystem, this.getAuthProfilesPath(agentId), store);
  }

  async discoverAgentIds(): Promise<string[]> {
    const agentsDir = join(this.configRepository.getConfigDir(), 'agents');
    try {
      if (!(await this.fileSystem.exists(agentsDir))) {
        return ['main'];
      }
      const entries = await this.fileSystem.listDirectory(agentsDir);
      const ids: string[] = [];
      for (const entry of entries) {
        if (entry.isDirectory && await this.fileSystem.exists(join(agentsDir, entry.name, 'agent'))) {
          ids.push(entry.name);
        }
      }
      return ids.length > 0 ? ids : ['main'];
    } catch {
      return ['main'];
    }
  }

  async readOpenClawJson(): Promise<Record<string, unknown>> {
    return await this.configRepository.read();
  }

}
