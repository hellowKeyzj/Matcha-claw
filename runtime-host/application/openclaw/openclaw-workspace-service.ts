import { join } from 'node:path';
import type { OpenClawWorkspaceConfigPort } from './openclaw-config-repository';
import { resolveMainWorkspaceDir, resolveTaskWorkspaceDirs, resolveWorkspaceDirForSession } from './openclaw-workspace-rules';
import type { RuntimeFileSystemPort } from '../common/runtime-ports';
import type { OpenClawEnvironmentRepository } from './openclaw-environment-repository';
import type { RuntimeHostLogger } from '../../shared/logger';

export interface OpenClawWorkspacePort {
  getConfigDir(): string;
  getSkillsDir(): string;
  getDefaultSkillReadmePath(skillKey: string): string;
  getPreviewRoots(): Promise<string[]>;
  getMainWorkspaceDir(): Promise<string>;
  getWorkspaceDirForSession(sessionKey: string): Promise<string>;
  getTaskWorkspaceDirs(): Promise<string[]>;
  migrateMainAgentTemplatesIfNeeded(): Promise<{ workspaceDir: string; migratedFiles: string[] }>;
}

const MAIN_AGENT_TEMPLATE_FILES = [
  'AGENTS.md',
  'SOUL.md',
  'TOOLS.md',
  'IDENTITY.md',
  'USER.md',
  'HEARTBEAT.md',
  'BOOTSTRAP.md',
] as const;

const UPSTREAM_TEMPLATE_SNAPSHOT_DIRNAME = 'templates-upstream-openclaw';

function normalizeTemplateText(content: string): string {
  return content.replace(/\r\n/g, '\n').trimEnd();
}

export class OpenClawWorkspaceService implements OpenClawWorkspacePort {
  constructor(
    private readonly config: OpenClawWorkspaceConfigPort,
    private readonly environment: Pick<OpenClawEnvironmentRepository, 'getResourcesPath' | 'getWorkingDir' | 'getOpenClawDirPath'>,
    private readonly fileSystem: RuntimeFileSystemPort,
    private readonly logger: RuntimeHostLogger,
  ) {}

  getConfigDir(): string {
    return this.config.getConfigDir();
  }

  getSkillsDir(): string {
    return join(this.config.getConfigDir(), 'skills');
  }

  getDefaultSkillReadmePath(skillKey: string): string {
    return join(this.getSkillsDir(), skillKey, 'SKILL.md');
  }

  async getPreviewRoots(): Promise<string[]> {
    const configDir = this.config.getConfigDir();
    const config = await this.config.read();
    return [
      this.getSkillsDir(),
      resolveMainWorkspaceDir(config, configDir),
      ...resolveTaskWorkspaceDirs(config, configDir),
    ];
  }

  async getMainWorkspaceDir(): Promise<string> {
    return resolveMainWorkspaceDir(await this.config.read(), this.config.getConfigDir());
  }

  async getWorkspaceDirForSession(sessionKey: string): Promise<string> {
    return resolveWorkspaceDirForSession(await this.config.read(), this.config.getConfigDir(), sessionKey);
  }

  async getTaskWorkspaceDirs(): Promise<string[]> {
    return resolveTaskWorkspaceDirs(await this.config.read(), this.config.getConfigDir());
  }

  private resolveManagedTemplateDir(): string {
    const resourcesPath = this.environment.getResourcesPath();
    const candidates = [
      resourcesPath ? join(resourcesPath, 'resources', 'agent-workspace-templates', 'main-agent') : '',
      resourcesPath ? join(resourcesPath, 'agent-workspace-templates', 'main-agent') : '',
      join(this.environment.getWorkingDir(), 'resources', 'agent-workspace-templates', 'main-agent'),
      join(this.environment.getOpenClawDirPath(), 'docs', 'reference', 'templates'),
    ].filter((item) => item.trim().length > 0);
    return candidates[0] ?? join(this.environment.getWorkingDir(), 'resources', 'agent-workspace-templates', 'main-agent');
  }

  private resolveUpstreamTemplateSnapshotDir(): string {
    return join(this.environment.getOpenClawDirPath(), 'docs', 'reference', UPSTREAM_TEMPLATE_SNAPSHOT_DIRNAME);
  }

  private async firstExistingTemplateDir(candidates: string[]): Promise<string | null> {
    for (const candidate of candidates) {
      if (await this.fileSystem.exists(join(candidate, 'AGENTS.md'))) {
        return candidate;
      }
    }
    return null;
  }

  private async tryReadTextFile(pathname: string): Promise<string | null> {
    try {
      return await this.fileSystem.readTextFile(pathname);
    } catch {
      return null;
    }
  }

  async migrateMainAgentTemplatesIfNeeded(): Promise<{ workspaceDir: string; migratedFiles: string[] }> {
    const workspaceDir = await this.getMainWorkspaceDir();
    if (!(await this.fileSystem.exists(workspaceDir))) {
      return { workspaceDir, migratedFiles: [] };
    }

    const resourcesPath = this.environment.getResourcesPath();
    const managedTemplateDir = await this.firstExistingTemplateDir([
      resourcesPath ? join(resourcesPath, 'resources', 'agent-workspace-templates', 'main-agent') : '',
      resourcesPath ? join(resourcesPath, 'agent-workspace-templates', 'main-agent') : '',
      join(this.environment.getWorkingDir(), 'resources', 'agent-workspace-templates', 'main-agent'),
      join(this.environment.getOpenClawDirPath(), 'docs', 'reference', 'templates'),
    ].filter((item) => item.trim().length > 0)) ?? this.resolveManagedTemplateDir();
    const upstreamTemplateDir = await this.firstExistingTemplateDir([
      this.resolveUpstreamTemplateSnapshotDir(),
      join(this.environment.getOpenClawDirPath(), 'docs', 'reference', 'templates'),
    ]) ?? this.resolveUpstreamTemplateSnapshotDir();

    if (!(await this.fileSystem.exists(join(managedTemplateDir, 'AGENTS.md')))) {
      this.logger.warn(`[workspace] Managed main-agent templates not found: ${managedTemplateDir}`);
      return { workspaceDir, migratedFiles: [] };
    }
    if (!(await this.fileSystem.exists(join(upstreamTemplateDir, 'AGENTS.md')))) {
      this.logger.warn(`[workspace] Upstream template snapshot not found: ${upstreamTemplateDir}`);
      return { workspaceDir, migratedFiles: [] };
    }

    const migratedFiles: string[] = [];
    for (const fileName of MAIN_AGENT_TEMPLATE_FILES) {
      const workspacePath = join(workspaceDir, fileName);
      const currentContent = await this.tryReadTextFile(workspacePath);
      if (currentContent === null) {
        continue;
      }
      const managedContent = await this.tryReadTextFile(join(managedTemplateDir, fileName));
      const upstreamContent = await this.tryReadTextFile(join(upstreamTemplateDir, fileName));
      if (managedContent === null || upstreamContent === null) {
        continue;
      }
      if (normalizeTemplateText(currentContent) !== normalizeTemplateText(upstreamContent)) {
        continue;
      }
      await this.fileSystem.writeTextFile(workspacePath, managedContent);
      migratedFiles.push(fileName);
    }

    if (migratedFiles.length > 0) {
      this.logger.info(`[workspace] Migrated main-agent templates in ${workspaceDir}: ${migratedFiles.join(', ')}`);
    }
    return { workspaceDir, migratedFiles };
  }
}
