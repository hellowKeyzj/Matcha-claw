import type { RuntimeFileSystemPort } from '../../common/runtime-ports';

export interface OpenClawEnvironmentConfigFileWorkflowDeps {
  readonly fileSystem: Pick<RuntimeFileSystemPort, 'exists' | 'ensureDirectory' | 'readTextFile' | 'writeTextFile'>;
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
    await this.deps.fileSystem.ensureDirectory(this.deps.layout.getOpenClawConfigDir());
    await this.deps.fileSystem.writeTextFile(this.deps.layout.getOpenClawConfigFilePath(), JSON.stringify(config, null, 2));
  }
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
