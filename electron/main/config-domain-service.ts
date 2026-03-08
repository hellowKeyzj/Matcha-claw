import { BrowserWindow } from 'electron';
import crypto from 'node:crypto';
import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '../utils/logger';

export interface ConfigChangedPayload {
  revision: number;
  reason: string;
  ts: number;
  hash?: string;
}

const WATCH_DEBOUNCE_MS = 200;
const EXTERNAL_STABLE_WINDOW_MS = 350;
const EXTERNAL_STABLE_MAX_WAIT_MS = 5000;
const OPENCLAW_CONFIG_FILE_NAME = 'openclaw.json';

export class ConfigDomainService {
  private readonly configPath: string;
  private revision = 0;
  private lastConfigHash: string | null = null;
  private watcher: FSWatcher | null = null;
  private watchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshChain: Promise<void> = Promise.resolve();
  private externalRefreshToken = 0;
  private disposed = false;

  constructor(
    private readonly mainWindow: BrowserWindow,
    configPath?: string,
  ) {
    this.configPath = configPath ?? join(homedir(), '.openclaw', OPENCLAW_CONFIG_FILE_NAME);
  }

  start(): void {
    this.lastConfigHash = this.readConfigHash();
    this.startFileWatcher();
  }

  dispose(): void {
    this.disposed = true;
    if (this.watchDebounceTimer) {
      clearTimeout(this.watchDebounceTimer);
      this.watchDebounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  markConfigPossiblyChanged(reason: string): Promise<void> {
    const run = async () => {
      if (this.disposed) {
        return;
      }
      const nextHash = this.readConfigHash();
      if (nextHash === this.lastConfigHash) {
        return;
      }
      this.lastConfigHash = nextHash;
      this.emitConfigChanged(reason, nextHash ?? undefined);
    };

    const task = this.refreshChain.then(run, run);
    this.refreshChain = task.catch(() => undefined);
    return task;
  }

  private startFileWatcher(): void {
    const configDir = dirname(this.configPath);
    if (!existsSync(configDir)) {
      logger.debug(`Config watcher skipped: directory does not exist (${configDir})`);
      return;
    }

    try {
      this.watcher = watch(configDir, (_eventType, fileName) => {
        if (this.disposed) {
          return;
        }

        if (typeof fileName === 'string' && fileName !== '' && fileName !== OPENCLAW_CONFIG_FILE_NAME) {
          return;
        }

        this.scheduleExternalRefresh();
      });

      this.watcher.on('error', (error) => {
        if (this.disposed) {
          return;
        }
        logger.warn('Config watcher error:', error);
      });
    } catch (error) {
      logger.warn('Failed to start config watcher:', error);
    }
  }

  private scheduleExternalRefresh(): void {
    const token = ++this.externalRefreshToken;
    if (this.watchDebounceTimer) {
      clearTimeout(this.watchDebounceTimer);
    }
    this.watchDebounceTimer = setTimeout(() => {
      this.watchDebounceTimer = null;
      if (token !== this.externalRefreshToken || this.disposed) {
        return;
      }
      void this.waitForExternalConfigStableThenEmit(token).catch((error) => {
        logger.warn('Failed to process external config change:', error);
      });
    }, WATCH_DEBOUNCE_MS);
  }

  private async waitForExternalConfigStableThenEmit(token: number): Promise<void> {
    const deadline = Date.now() + EXTERNAL_STABLE_MAX_WAIT_MS;
    let observedHash = this.readConfigHash();

    while (!this.disposed && token === this.externalRefreshToken) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, EXTERNAL_STABLE_WINDOW_MS);
      });

      if (this.disposed || token !== this.externalRefreshToken) {
        return;
      }

      const nextHash = this.readConfigHash();
      if (nextHash === observedHash) {
        await this.markConfigPossiblyChanged('external-write');
        return;
      }

      observedHash = nextHash;
      if (Date.now() >= deadline) {
        await this.markConfigPossiblyChanged('external-write-timeout');
        return;
      }
    }
  }

  private readConfigHash(): string | null {
    try {
      if (!existsSync(this.configPath)) {
        return null;
      }
      const content = readFileSync(this.configPath);
      return crypto.createHash('sha256').update(content).digest('hex');
    } catch (error) {
      logger.warn('Failed to read openclaw.json hash:', error);
      return null;
    }
  }

  private emitConfigChanged(reason: string, hash?: string): void {
    if (this.disposed || this.mainWindow.isDestroyed()) {
      return;
    }

    const payload: ConfigChangedPayload = {
      revision: ++this.revision,
      reason,
      ts: Date.now(),
      ...(hash ? { hash } : {}),
    };
    this.mainWindow.webContents.send('config:changed', payload);
  }
}
