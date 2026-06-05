import { join } from 'node:path';
import type { RuntimeFileSystemPort } from '../../common/runtime-ports';
import type { OpenClawStatusSnapshot } from '../../infrastructure/openclaw-environment-repository';

export interface OpenClawEnvironmentStatusWorkflowDeps {
  readonly fileSystem: Pick<RuntimeFileSystemPort, 'exists' | 'readTextFile'>;
  readonly layout: {
    getOpenClawDirPath(): string;
  };
}

export class OpenClawEnvironmentStatusWorkflow {
  constructor(private readonly deps: OpenClawEnvironmentStatusWorkflowDeps) {}

  async getOpenClawStatus(): Promise<OpenClawStatusSnapshot> {
    const dir = this.deps.layout.getOpenClawDirPath();
    const entryPath = join(dir, 'openclaw.mjs');
    const packagePath = join(dir, 'package.json');
    const distDir = join(dir, 'dist');
    const packageExists = (await this.deps.fileSystem.exists(dir)) && (await this.deps.fileSystem.exists(packagePath));
    const isBuilt = await this.deps.fileSystem.exists(distDir);
    const version = packageExists ? await this.readPackageVersion(packagePath) : undefined;
    return {
      packageExists,
      isBuilt,
      entryPath,
      dir,
      ...(version ? { version } : {}),
    };
  }

  private async readPackageVersion(packagePath: string): Promise<string | undefined> {
    try {
      const parsed = parseJsonRecord(await this.deps.fileSystem.readTextFile(packagePath));
      return typeof parsed?.version === 'string' && parsed.version.trim()
        ? parsed.version
        : undefined;
    } catch {
      return undefined;
    }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
