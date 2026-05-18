import { join } from 'node:path';
import type { OpenClawWorkspaceConfigPort } from './openclaw-config-repository';
import { resolveMainWorkspaceDir, resolveTaskWorkspaceDirs, resolveWorkspaceDirForSession } from './openclaw-workspace-rules';
import type { RuntimeFileSystemPort } from '../common/runtime-ports';
import type { OpenClawEnvironmentRepository } from './openclaw-environment-repository';
import type { RuntimeHostLogger } from '../../shared/logger';
import { mergeWorkspaceContext, type ContextMergeResult } from './workspace-context-merge';

export interface OpenClawWorkspacePort {
  getConfigDir(): string;
  getSkillsDir(): string;
  getDefaultSkillReadmePath(skillKey: string): string;
  getPreviewRoots(): Promise<string[]>;
  getMainWorkspaceDir(): Promise<string>;
  getWorkspaceDirForSession(sessionKey: string): Promise<string>;
  getTaskWorkspaceDirs(): Promise<string[]>;
  ensureIdentityFile(workspaceDir: string, options?: { createDir?: boolean }): Promise<{ wroteIdentity: boolean; replacedTemplate: boolean; removedBootstrap: boolean }>;
  ensureDefaultIdentity(): Promise<{ workspaceDirs: string[]; seededFiles: string[]; replacedTemplateFiles: string[]; removedBootstrapFiles: string[] }>;
  migrateMainAgentTemplatesIfNeeded(): Promise<{ workspaceDir: string; migratedFiles: string[] }>;
  mergeContextSnippets(): Promise<ContextMergeResult>;
}

const MAIN_AGENT_TEMPLATE_FILES = [
  'AGENTS.md',
  'SOUL.md',
  'TOOLS.md',
  'IDENTITY.md',
  'USER.md',
  'HEARTBEAT.md',
] as const;

const UPSTREAM_TEMPLATE_SNAPSHOT_DIRNAME = 'templates-upstream-openclaw';
const DEFAULT_IDENTITY_FILE_NAME = 'IDENTITY.md';
const LEGACY_BOOTSTRAP_FILE_NAME = 'BOOTSTRAP.md';
const FALLBACK_IDENTITY_CONTENT = [
  '# IDENTITY.md',
  '',
  '- **Name:** Matcha',
  '- **Role:** MatchaClaw desktop agent',
  '- **Vibe:** calm, clear, and reliable',
  '- **Mission:** Turn MatchaClaw capabilities into clear, reliable, actionable results',
  '',
].join('\n');

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

  async ensureIdentityFile(
    workspaceDir: string,
    options: { createDir?: boolean } = {},
  ): Promise<{ wroteIdentity: boolean; replacedTemplate: boolean; removedBootstrap: boolean }> {
    if (options.createDir) {
      await this.fileSystem.ensureDirectory(workspaceDir);
    } else if (!(await this.fileSystem.exists(workspaceDir))) {
      return { wroteIdentity: false, replacedTemplate: false, removedBootstrap: false };
    }

    const identityPath = join(workspaceDir, DEFAULT_IDENTITY_FILE_NAME);
    const defaultIdentity = await this.readDefaultIdentityContent();
    let wroteIdentity = await this.fileSystem.writeTextFileExclusive(identityPath, defaultIdentity);
    let replacedTemplate = false;

    if (!wroteIdentity) {
      const currentContent = await this.tryReadTextFile(identityPath);
      const upstreamContent = await this.readUpstreamIdentityTemplate();
      if (
        currentContent !== null
        && upstreamContent !== null
        && normalizeTemplateText(currentContent) === normalizeTemplateText(upstreamContent)
      ) {
        await this.fileSystem.writeTextFile(identityPath, defaultIdentity);
        wroteIdentity = true;
        replacedTemplate = true;
      }
    }

    const bootstrapPath = join(workspaceDir, LEGACY_BOOTSTRAP_FILE_NAME);
    let removedBootstrap = false;
    if (await this.fileSystem.exists(bootstrapPath)) {
      await this.fileSystem.removeFile(bootstrapPath);
      removedBootstrap = true;
    }

    return { wroteIdentity, replacedTemplate, removedBootstrap };
  }

  async ensureDefaultIdentity(): Promise<{ workspaceDirs: string[]; seededFiles: string[]; replacedTemplateFiles: string[]; removedBootstrapFiles: string[] }> {
    const workspaceDirs = await this.getTaskWorkspaceDirs();
    const seededFiles: string[] = [];
    const replacedTemplateFiles: string[] = [];
    const removedBootstrapFiles: string[] = [];

    for (const workspaceDir of workspaceDirs) {
      const result = await this.ensureIdentityFile(workspaceDir, { createDir: true });
      if (result.wroteIdentity) {
        seededFiles.push(join(workspaceDir, DEFAULT_IDENTITY_FILE_NAME));
      }
      if (result.replacedTemplate) {
        replacedTemplateFiles.push(join(workspaceDir, DEFAULT_IDENTITY_FILE_NAME));
      }
      if (result.removedBootstrap) {
        removedBootstrapFiles.push(join(workspaceDir, LEGACY_BOOTSTRAP_FILE_NAME));
      }
    }

    if (seededFiles.length > 0) {
      this.logger.info(`[workspace] Ensured default identity files: ${seededFiles.length}`);
    }
    if (removedBootstrapFiles.length > 0) {
      this.logger.info(`[workspace] Removed legacy bootstrap files: ${removedBootstrapFiles.length}`);
    }

    return { workspaceDirs, seededFiles, replacedTemplateFiles, removedBootstrapFiles };
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

  private async firstExistingFileDir(candidates: string[], fileName: string): Promise<string | null> {
    for (const candidate of candidates) {
      if (await this.fileSystem.exists(join(candidate, fileName))) {
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

  private async readDefaultIdentityContent(): Promise<string> {
    const managedTemplateDir = await this.firstExistingFileDir([
      this.resolveManagedTemplateDir(),
      join(this.environment.getWorkingDir(), 'resources', 'agent-workspace-templates', 'main-agent'),
    ], DEFAULT_IDENTITY_FILE_NAME);
    const managedContent = managedTemplateDir
      ? await this.tryReadTextFile(join(managedTemplateDir, DEFAULT_IDENTITY_FILE_NAME))
      : null;
    return managedContent ?? FALLBACK_IDENTITY_CONTENT;
  }

  private async readUpstreamIdentityTemplate(): Promise<string | null> {
    const upstreamTemplateDir = await this.firstExistingFileDir([
      this.resolveUpstreamTemplateSnapshotDir(),
      join(this.environment.getOpenClawDirPath(), 'docs', 'reference', 'templates'),
    ], DEFAULT_IDENTITY_FILE_NAME);
    return upstreamTemplateDir
      ? await this.tryReadTextFile(join(upstreamTemplateDir, DEFAULT_IDENTITY_FILE_NAME))
      : null;
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

  async mergeContextSnippets(): Promise<ContextMergeResult> {
    const contextDir = await this.firstExistingContextDir();
    if (!contextDir) {
      this.logger.debug('[context-merge] No context directory found in any candidate path');
      return { mergedFiles: [], skippedMissing: 0 };
    }

    const workspaceDirs = await this.getTaskWorkspaceDirs();
    const combined: ContextMergeResult = { mergedFiles: [], skippedMissing: 0 };

    for (const workspaceDir of workspaceDirs) {
      const result = await mergeWorkspaceContext(this.fileSystem, this.logger, contextDir, workspaceDir);
      combined.mergedFiles.push(...result.mergedFiles);
      combined.skippedMissing += result.skippedMissing;
    }

    return combined;
  }

  private async firstExistingContextDir(): Promise<string | null> {
    const resourcesPath = this.environment.getResourcesPath();
    const candidates = [
      resourcesPath ? join(resourcesPath, 'resources', 'context') : '',
      resourcesPath ? join(resourcesPath, 'context') : '',
      join(this.environment.getWorkingDir(), 'resources', 'context'),
    ].filter((p) => p.length > 0);

    for (const candidate of candidates) {
      if (await this.fileSystem.exists(candidate)) {
        return candidate;
      }
    }
    return null;
  }
}
