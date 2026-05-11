import type { OpenClawEnvironmentRepository } from './openclaw-environment-repository';
import { withOpenClawConfigLock } from './openclaw-config-mutex';

export interface OpenClawConfigRepositoryPort {
  read(): Promise<Record<string, unknown>>;
  write(config: Record<string, unknown>): Promise<void>;
  update<T>(mutate: (config: Record<string, unknown>) => Promise<T> | T): Promise<T>;
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

  async update<T>(mutate: (config: Record<string, unknown>) => Promise<T> | T): Promise<T> {
    return await withOpenClawConfigLock(async () => {
      const config = await this.read();
      return await mutate(config);
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
