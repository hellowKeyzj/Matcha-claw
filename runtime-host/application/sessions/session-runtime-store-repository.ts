import { dirname, join } from 'node:path';
import type { RuntimeFileSystemPort } from '../common/runtime-ports';
import type { OpenClawWorkspacePort } from '../openclaw/openclaw-workspace-service';

export interface PersistedSessionRuntimeStore {
  version: 3;
  activeSessionKey: string | null;
}

export interface SessionRuntimeStoreRepositoryDeps {
  workspace: Pick<OpenClawWorkspacePort, 'getConfigDir'>;
  fileSystem: RuntimeFileSystemPort;
}

export interface SessionRuntimeStorePort {
  load(): Promise<PersistedSessionRuntimeStore>;
  save(store: PersistedSessionRuntimeStore): Promise<void>;
}

function normalizeActiveSessionKey(value: unknown): string | null {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : null;
}

export class SessionRuntimeStoreRepository implements SessionRuntimeStorePort {
  private readonly storeFilePath: string;

  constructor(private readonly deps: SessionRuntimeStoreRepositoryDeps) {
    this.storeFilePath = join(this.deps.workspace.getConfigDir(), 'matchaclaw-session-runtime-store.json');
  }

  async load(): Promise<PersistedSessionRuntimeStore> {
    try {
      const parsed = JSON.parse(await this.deps.fileSystem.readTextFile(this.storeFilePath)) as unknown;
      if (!parsed || typeof parsed !== 'object') {
        return {
          version: 3,
          activeSessionKey: null,
        };
      }
      return {
        version: 3,
        activeSessionKey: normalizeActiveSessionKey((parsed as Record<string, unknown>).activeSessionKey),
      };
    } catch {
      return {
        version: 3,
        activeSessionKey: null,
      };
    }
  }

  async save(store: PersistedSessionRuntimeStore): Promise<void> {
    const payload: PersistedSessionRuntimeStore = {
      version: 3,
      activeSessionKey: normalizeActiveSessionKey(store.activeSessionKey),
    };
    await this.deps.fileSystem.ensureDirectory(dirname(this.storeFilePath));
    await this.deps.fileSystem.writeTextFile(this.storeFilePath, JSON.stringify(payload, null, 2));
  }
}
