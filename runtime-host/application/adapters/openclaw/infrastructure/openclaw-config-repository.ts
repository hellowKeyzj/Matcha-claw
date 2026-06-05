import type { OpenClawEnvironmentRepository } from './openclaw-environment-repository';
import { withOpenClawConfigLock } from './openclaw-config-mutex';

export interface OpenClawConfigUpdateResult<T> {
  readonly result: T;
  readonly changed: boolean;
}

export interface OpenClawConfigPatchResult<T> {
  readonly result: T;
  readonly value: unknown;
  readonly changed: boolean;
}

export interface OpenClawConfigRepositoryPort {
  read(): Promise<Record<string, unknown>>;
  write(config: Record<string, unknown>): Promise<void>;
  updateDirty<T>(mutate: (config: Record<string, unknown>) => Promise<OpenClawConfigUpdateResult<T>> | OpenClawConfigUpdateResult<T>): Promise<T>;
  patchSection<T>(sectionKey: string, mutate: (value: unknown, config: Record<string, unknown>) => Promise<OpenClawConfigPatchResult<T>> | OpenClawConfigPatchResult<T>): Promise<T>;
  getConfigDir(): string;
  getConfigFilePath(): string;
  getOpenClawDirPath(): string;
}

export interface OpenClawWorkspaceConfigPort extends Pick<OpenClawConfigRepositoryPort, 'read' | 'getConfigDir'> {}

export class OpenClawConfigRepository implements OpenClawConfigRepositoryPort {
  constructor(
    private readonly environment: OpenClawEnvironmentRepository,
  ) {}

  async read(): Promise<Record<string, unknown>> {
    return await this.environment.readOpenClawConfigJson();
  }

  async write(config: Record<string, unknown>): Promise<void> {
    await this.environment.writeOpenClawConfigJson(config);
  }

  async updateDirty<T>(mutate: (config: Record<string, unknown>) => Promise<OpenClawConfigUpdateResult<T>> | OpenClawConfigUpdateResult<T>): Promise<T> {
    return await withOpenClawConfigLock(async () => {
      const config = await this.read();
      const update = await mutate(config);
      if (update.changed) {
        await this.write(config);
      }
      return update.result;
    });
  }

  async patchSection<T>(sectionKey: string, mutate: (value: unknown, config: Record<string, unknown>) => Promise<OpenClawConfigPatchResult<T>> | OpenClawConfigPatchResult<T>): Promise<T> {
    return await withOpenClawConfigLock(async () => {
      const config = await this.read();
      const update = await mutate(config[sectionKey], config);
      if (update.changed) {
        if (update.value === undefined) {
          delete config[sectionKey];
        } else {
          config[sectionKey] = update.value;
        }
        await this.write(config);
      }
      return update.result;
    });
  }

  getConfigDir(): string {
    return this.environment.getOpenClawConfigDir();
  }

  getConfigFilePath(): string {
    return this.environment.getOpenClawConfigFilePath();
  }

  getOpenClawDirPath(): string {
    return this.environment.getOpenClawDirPath();
  }
}
