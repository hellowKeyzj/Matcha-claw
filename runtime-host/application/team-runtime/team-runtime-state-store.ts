import path from 'node:path';
import type { RuntimeFileSystemPort } from '../common/runtime-ports';

export interface TeamRuntimeDataRootPort {
  getRuntimeDataRootDir(): string;
}

export interface TeamRuntimeStateStore {
  readRunState(runId: string): Promise<unknown | null>;
  writeRunState(runId: string, state: unknown): Promise<void>;
  deleteRunState(runId: string): Promise<void>;
  readTeamInstance(teamId: string): Promise<unknown | null>;
  listTeamInstances(): Promise<unknown[]>;
  writeTeamInstance(teamId: string, instance: unknown): Promise<void>;
  deleteTeamInstance(teamId: string): Promise<void>;
}

export class FileTeamRuntimeStateStore implements TeamRuntimeStateStore {
  constructor(private readonly deps: {
    readonly runtimeData: TeamRuntimeDataRootPort;
    readonly fileSystem: Pick<RuntimeFileSystemPort, 'ensureDirectory' | 'listDirectory' | 'readTextFile' | 'writeTextFile' | 'removeFile' | 'rename'>;
  }) {}

  async readRunState(runId: string): Promise<unknown | null> {
    return await this.readJsonFile(this.runStatePath(runId));
  }

  async writeRunState(runId: string, state: unknown): Promise<void> {
    await this.writeJsonFile(this.runStatePath(runId), state);
  }

  async deleteRunState(runId: string): Promise<void> {
    try {
      await this.deps.fileSystem.removeFile(this.runStatePath(runId));
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }
  }

  async readTeamInstance(teamId: string): Promise<unknown | null> {
    return await this.readJsonFile(this.teamInstancePath(teamId));
  }

  async listTeamInstances(): Promise<unknown[]> {
    let entries;
    try {
      entries = await this.deps.fileSystem.listDirectory(this.teamInstancesDirectoryPath());
    } catch (error) {
      if (isNotFoundError(error)) return [];
      throw error;
    }

    const instances: unknown[] = [];
    for (const entry of entries) {
      if (!entry.isFile || !entry.name.endsWith('.json')) continue;
      instances.push(JSON.parse(await this.deps.fileSystem.readTextFile(path.join(this.teamInstancesDirectoryPath(), entry.name))));
    }
    return instances;
  }

  async writeTeamInstance(teamId: string, instance: unknown): Promise<void> {
    await this.writeJsonFile(this.teamInstancePath(teamId), instance);
  }

  async deleteTeamInstance(teamId: string): Promise<void> {
    try {
      await this.deps.fileSystem.removeFile(this.teamInstancePath(teamId));
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }
  }

  private async readJsonFile(filePath: string): Promise<unknown | null> {
    try {
      return JSON.parse(await this.deps.fileSystem.readTextFile(filePath));
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw error;
    }
  }

  private async writeJsonFile(filePath: string, value: unknown): Promise<void> {
    const temporaryFilePath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    let writeError: unknown;

    try {
      await this.deps.fileSystem.ensureDirectory(path.dirname(filePath));
      await this.deps.fileSystem.writeTextFile(temporaryFilePath, `${JSON.stringify(value, null, 2)}\n`);
      await this.deps.fileSystem.rename(temporaryFilePath, filePath);
    } catch (error) {
      writeError = error;
      throw error;
    } finally {
      try {
        await this.deps.fileSystem.removeFile(temporaryFilePath);
      } catch (cleanupError) {
        if (!isNotFoundError(cleanupError) && !writeError) {
          throw cleanupError;
        }
      }
    }
  }

  private runStatePath(runId: string): string {
    return path.join(this.deps.runtimeData.getRuntimeDataRootDir(), 'team-runtime', 'runs', `${sanitizePathSegment(runId)}.json`);
  }

  private teamInstancesDirectoryPath(): string {
    return path.join(this.deps.runtimeData.getRuntimeDataRootDir(), 'team-runtime', 'teams');
  }

  private teamInstancePath(teamId: string): string {
    return path.join(this.teamInstancesDirectoryPath(), `${sanitizePathSegment(teamId)}.json`);
  }
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT');
}
