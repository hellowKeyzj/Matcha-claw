import { join } from 'node:path';
import type { RuntimeFileSystemPort } from '../../common/runtime-ports';
import type { ClawHubCliRunner } from '../../skills/clawhub-cli';

export interface ClawHubSkillInstallWorkflowDeps {
  readonly cliRunner: Pick<ClawHubCliRunner, 'runWithRegistryFallback'>;
  readonly fileSystem: Pick<RuntimeFileSystemPort, 'removeDirectory' | 'exists' | 'readTextFile' | 'writeTextFile'>;
  readonly skillsRoot: () => string;
  readonly lockFilePath: () => string;
}

export class ClawHubSkillInstallWorkflow {
  constructor(private readonly deps: ClawHubSkillInstallWorkflowDeps) {}

  async executeInstall(params: Record<string, unknown>) {
    const slug = readRequiredString(params.slug, 'slug');
    const args = ['install', slug];
    if (typeof params.version === 'string' && params.version.trim()) {
      args.push('--version', params.version.trim());
    }
    if (params.force === true) {
      args.push('--force');
    }
    const result = await this.deps.cliRunner.runWithRegistryFallback(args);
    if (!result.ok) {
      throw new Error(result.error || 'clawhub install failed');
    }
    return { success: true };
  }

  async executeUninstall(params: Record<string, unknown>) {
    const slug = readRequiredString(params.slug, 'slug');
    await this.deps.fileSystem.removeDirectory(join(this.deps.skillsRoot(), slug));
    await this.removeLockEntry(slug);
    return { success: true };
  }

  private async removeLockEntry(slug: string): Promise<void> {
    const lockFile = this.deps.lockFilePath();
    if (!(await this.deps.fileSystem.exists(lockFile))) {
      return;
    }
    try {
      const parsed = JSON.parse(await this.deps.fileSystem.readTextFile(lockFile));
      if (isRecord(parsed) && isRecord(parsed.skills) && Object.prototype.hasOwnProperty.call(parsed.skills, slug)) {
        delete parsed.skills[slug];
        await this.deps.fileSystem.writeTextFile(lockFile, `${JSON.stringify(parsed, null, 2)}\n`);
      }
    } catch {
      // ignore
    }
  }
}

function readRequiredString(value: unknown, fieldName: string) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    throw new Error(`${fieldName} is required`);
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
