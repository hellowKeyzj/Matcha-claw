import { basename, dirname, join } from 'node:path';
import type { RuntimeFileSystemPort } from '../../common/runtime-ports';

export interface OpenClawEnvironmentConfigFileWorkflowDeps {
  readonly fileSystem: Pick<RuntimeFileSystemPort, 'exists' | 'ensureDirectory' | 'readTextFile' | 'writeTextFile' | 'removeFile' | 'rename'>;
  readonly layout: {
    getOpenClawConfigDir(): string;
    getOpenClawConfigFilePath(): string;
  };
}

export class OpenClawEnvironmentConfigFileWorkflow {
  constructor(private readonly deps: OpenClawEnvironmentConfigFileWorkflowDeps) {}

  async readOpenClawConfigJson(): Promise<Record<string, unknown>> {
    const path = this.deps.layout.getOpenClawConfigFilePath();
    if (!(await this.deps.fileSystem.exists(path))) {
      return {};
    }
    return parseRequiredJsonRecord(await this.deps.fileSystem.readTextFile(path), path);
  }

  async writeOpenClawConfigJson(config: Record<string, unknown>): Promise<void> {
    const configDir = this.deps.layout.getOpenClawConfigDir();
    const configPath = this.deps.layout.getOpenClawConfigFilePath();
    const tempPath = join(dirname(configPath), `.${basename(configPath)}.${process.pid}.${Date.now()}.tmp`);
    const content = JSON.stringify(config, null, 2);
    await this.deps.fileSystem.ensureDirectory(configDir);
    try {
      await this.deps.fileSystem.writeTextFile(tempPath, content);
      try {
        await this.deps.fileSystem.rename(tempPath, configPath);
      } catch (error) {
        if (!isRecoverableFileReplaceError(error)) {
          throw error;
        }
        await this.deps.fileSystem.writeTextFile(configPath, content);
        await this.deps.fileSystem.removeFile(tempPath).catch(() => undefined);
      }
    } catch (error) {
      await this.deps.fileSystem.removeFile(tempPath).catch(() => undefined);
      throw error;
    }
  }
}

function isRecoverableFileReplaceError(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }
  return error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'EBUSY';
}

function parseJsonRecord(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseRequiredJsonRecord(raw: string, path: string): Record<string, unknown> {
  const parsed = parseJsonRecord(raw);
  if (!parsed) {
    throw new Error(`Invalid OpenClaw config JSON: ${path}`);
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
