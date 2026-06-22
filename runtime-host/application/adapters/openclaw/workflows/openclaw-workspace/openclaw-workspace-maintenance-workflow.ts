import { join } from 'node:path';
import type { RuntimeFileSystemPort } from '../../common/runtime-ports';
import type { OpenClawEnvironmentRepository } from '../../infrastructure/openclaw-environment-repository';
import type { OpenClawWorkspaceQueryWorkflow } from './openclaw-workspace-query-workflow';
import { mergeWorkspaceContext, type ContextMergeResult } from '../../infrastructure/openclaw-workspace-context-merge';
import type { RuntimeHostLogger } from '../../../../../shared/logger';

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
export type AgentWorkspaceInitialization = 'mainAgentTemplate' | 'emptyWorkspace';
export interface AgentWorkspaceInitializationResult {
  readonly workspaceDir: string;
  readonly initializedFiles: string[];
  readonly replacedTemplateFiles: string[];
  readonly removedBootstrapFiles: string[];
}
const FALLBACK_IDENTITY_CONTENT = [
  '# IDENTITY.md',
  '',
  '- **Name:** Matcha',
  '- **Role:** MatchaClaw desktop agent',
  '- **Vibe:** calm, clear, and reliable',
  '- **Mission:** Turn MatchaClaw capabilities into clear, reliable, actionable results',
  '',
].join('\n');

export interface OpenClawWorkspaceMaintenanceWorkflowDeps {
  readonly workspaceQuery: Pick<OpenClawWorkspaceQueryWorkflow,
    | 'getMainWorkspaceDir'
    | 'getTaskWorkspaceDirs'
  >;
  readonly environment: Pick<OpenClawEnvironmentRepository, 'getResourcesPath' | 'getWorkingDir' | 'getOpenClawDirPath'>;
  readonly fileSystem: RuntimeFileSystemPort;
  readonly logger: RuntimeHostLogger;
}

export class OpenClawWorkspaceMaintenanceWorkflow {
  constructor(private readonly deps: OpenClawWorkspaceMaintenanceWorkflowDeps) {}

  async initializeAgentWorkspace(
    workspaceDir: string,
    options: { createDir?: boolean; workspaceInitialization: AgentWorkspaceInitialization },
  ): Promise<AgentWorkspaceInitializationResult> {
    const emptyResult = (): AgentWorkspaceInitializationResult => ({
      workspaceDir,
      initializedFiles: [],
      replacedTemplateFiles: [],
      removedBootstrapFiles: [],
    });

    if (options.createDir) {
      await this.deps.fileSystem.ensureDirectory(workspaceDir);
    } else if (!(await this.deps.fileSystem.exists(workspaceDir))) {
      return emptyResult();
    }

    if (options.workspaceInitialization === 'emptyWorkspace') {
      return emptyResult();
    }

    const result = await this.ensureMainAgentTemplateFiles(workspaceDir);
    const bootstrapPath = join(workspaceDir, LEGACY_BOOTSTRAP_FILE_NAME);
    if (await this.deps.fileSystem.exists(bootstrapPath)) {
      await this.deps.fileSystem.removeFile(bootstrapPath);
      result.removedBootstrapFiles.push(bootstrapPath);
    }
    return result;
  }

  async ensureIdentityFile(
    workspaceDir: string,
    options: { createDir?: boolean } = {},
  ): Promise<{ wroteIdentity: boolean; replacedTemplate: boolean; removedBootstrap: boolean }> {
    if (options.createDir) {
      await this.deps.fileSystem.ensureDirectory(workspaceDir);
    } else if (!(await this.deps.fileSystem.exists(workspaceDir))) {
      return { wroteIdentity: false, replacedTemplate: false, removedBootstrap: false };
    }

    const identityPath = join(workspaceDir, DEFAULT_IDENTITY_FILE_NAME);
    const defaultIdentity = await this.readDefaultIdentityContent();
    let wroteIdentity = await this.deps.fileSystem.writeTextFileExclusive(identityPath, defaultIdentity);
    let replacedTemplate = false;

    if (!wroteIdentity) {
      const currentContent = await this.tryReadTextFile(identityPath);
      const upstreamContent = await this.readUpstreamIdentityTemplate();
      if (
        currentContent !== null
        && upstreamContent !== null
        && normalizeTemplateText(currentContent) === normalizeTemplateText(upstreamContent)
      ) {
        await this.deps.fileSystem.writeTextFile(identityPath, defaultIdentity);
        wroteIdentity = true;
        replacedTemplate = true;
      }
    }

    const bootstrapPath = join(workspaceDir, LEGACY_BOOTSTRAP_FILE_NAME);
    let removedBootstrap = false;
    if (await this.deps.fileSystem.exists(bootstrapPath)) {
      await this.deps.fileSystem.removeFile(bootstrapPath);
      removedBootstrap = true;
    }

    return { wroteIdentity, replacedTemplate, removedBootstrap };
  }

  async ensureDefaultIdentity(): Promise<{ workspaceDirs: string[]; seededFiles: string[]; replacedTemplateFiles: string[]; removedBootstrapFiles: string[] }> {
    const workspaceDirs = await this.deps.workspaceQuery.getTaskWorkspaceDirs();
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
      this.deps.logger.info(`[workspace] Ensured default identity files: ${seededFiles.length}`);
    }
    if (removedBootstrapFiles.length > 0) {
      this.deps.logger.info(`[workspace] Removed legacy bootstrap files: ${removedBootstrapFiles.length}`);
    }

    return { workspaceDirs, seededFiles, replacedTemplateFiles, removedBootstrapFiles };
  }

  async migrateMainAgentTemplatesIfNeeded(): Promise<{ workspaceDir: string; migratedFiles: string[] }> {
    const workspaceDir = await this.deps.workspaceQuery.getMainWorkspaceDir();
    if (!(await this.deps.fileSystem.exists(workspaceDir))) {
      return { workspaceDir, migratedFiles: [] };
    }

    const resourcesPath = this.deps.environment.getResourcesPath();
    const managedTemplateDir = await this.firstExistingTemplateDir([
      resourcesPath ? join(resourcesPath, 'resources', 'agent-workspace-templates', 'main-agent') : '',
      resourcesPath ? join(resourcesPath, 'agent-workspace-templates', 'main-agent') : '',
      join(this.deps.environment.getWorkingDir(), 'resources', 'agent-workspace-templates', 'main-agent'),
      join(this.deps.environment.getOpenClawDirPath(), 'docs', 'reference', 'templates'),
    ].filter((item) => item.trim().length > 0)) ?? this.resolveManagedTemplateDir();
    const upstreamTemplateDir = await this.firstExistingTemplateDir([
      this.resolveUpstreamTemplateSnapshotDir(),
      join(this.deps.environment.getOpenClawDirPath(), 'docs', 'reference', 'templates'),
    ]) ?? this.resolveUpstreamTemplateSnapshotDir();

    if (!(await this.deps.fileSystem.exists(join(managedTemplateDir, 'AGENTS.md')))) {
      this.deps.logger.warn(`[workspace] Managed main-agent templates not found: ${managedTemplateDir}`);
      return { workspaceDir, migratedFiles: [] };
    }
    if (!(await this.deps.fileSystem.exists(join(upstreamTemplateDir, 'AGENTS.md')))) {
      this.deps.logger.warn(`[workspace] Upstream template snapshot not found: ${upstreamTemplateDir}`);
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
      await this.deps.fileSystem.writeTextFile(workspacePath, managedContent);
      migratedFiles.push(fileName);
    }

    if (migratedFiles.length > 0) {
      this.deps.logger.info(`[workspace] Migrated main-agent templates in ${workspaceDir}: ${migratedFiles.join(', ')}`);
    }
    return { workspaceDir, migratedFiles };
  }

  async mergeContextSnippets(): Promise<ContextMergeResult> {
    const contextDir = await this.firstExistingContextDir();
    if (!contextDir) {
      this.deps.logger.debug('[context-merge] No context directory found in any candidate path');
      return { mergedFiles: [], skippedMissing: 0 };
    }

    const workspaceDirs = await this.deps.workspaceQuery.getTaskWorkspaceDirs();
    const combined: ContextMergeResult = { mergedFiles: [], skippedMissing: 0 };

    for (const workspaceDir of workspaceDirs) {
      const result = await mergeWorkspaceContext(this.deps.fileSystem, this.deps.logger, contextDir, workspaceDir);
      combined.mergedFiles.push(...result.mergedFiles);
      combined.skippedMissing += result.skippedMissing;
    }

    return combined;
  }

  private async ensureMainAgentTemplateFiles(workspaceDir: string): Promise<AgentWorkspaceInitializationResult> {
    const result: AgentWorkspaceInitializationResult = {
      workspaceDir,
      initializedFiles: [],
      replacedTemplateFiles: [],
      removedBootstrapFiles: [],
    };
    const managedTemplateContentByFile = await this.readManagedTemplateContentByFile();
    const upstreamTemplateContentByFile = await this.readUpstreamTemplateContentByFile();

    for (const fileName of MAIN_AGENT_TEMPLATE_FILES) {
      const managedContent = managedTemplateContentByFile.get(fileName);
      if (managedContent === undefined) {
        continue;
      }
      const workspacePath = join(workspaceDir, fileName);
      const wroteTemplate = await this.deps.fileSystem.writeTextFileExclusive(workspacePath, managedContent);
      if (wroteTemplate) {
        result.initializedFiles.push(workspacePath);
        continue;
      }

      const currentContent = await this.tryReadTextFile(workspacePath);
      const upstreamContent = upstreamTemplateContentByFile.get(fileName);
      if (
        currentContent === null
        || upstreamContent === undefined
        || normalizeTemplateText(currentContent) !== normalizeTemplateText(upstreamContent)
      ) {
        continue;
      }
      await this.deps.fileSystem.writeTextFile(workspacePath, managedContent);
      result.replacedTemplateFiles.push(workspacePath);
    }

    return result;
  }

  private async readManagedTemplateContentByFile(): Promise<Map<string, string>> {
    const managedTemplateDir = await this.firstExistingTemplateDir(this.managedTemplateDirCandidates())
      ?? this.resolveManagedTemplateDir();
    const contentByFile = await this.readTemplateContentByFile(managedTemplateDir);
    if (!contentByFile.has(DEFAULT_IDENTITY_FILE_NAME)) {
      contentByFile.set(DEFAULT_IDENTITY_FILE_NAME, FALLBACK_IDENTITY_CONTENT);
    }
    return contentByFile;
  }

  private async readUpstreamTemplateContentByFile(): Promise<Map<string, string>> {
    const upstreamTemplateDir = await this.firstExistingTemplateDir([
      this.resolveUpstreamTemplateSnapshotDir(),
      join(this.deps.environment.getOpenClawDirPath(), 'docs', 'reference', 'templates'),
    ]) ?? this.resolveUpstreamTemplateSnapshotDir();
    return await this.readTemplateContentByFile(upstreamTemplateDir);
  }

  private async readTemplateContentByFile(templateDir: string): Promise<Map<string, string>> {
    const contentByFile = new Map<string, string>();
    for (const fileName of MAIN_AGENT_TEMPLATE_FILES) {
      const content = await this.tryReadTextFile(join(templateDir, fileName));
      if (content !== null) {
        contentByFile.set(fileName, content);
      }
    }
    return contentByFile;
  }

  private resolveManagedTemplateDir(): string {
    return this.managedTemplateDirCandidates()[0]
      ?? join(this.deps.environment.getWorkingDir(), 'resources', 'agent-workspace-templates', 'main-agent');
  }

  private managedTemplateDirCandidates(): string[] {
    const resourcesPath = this.deps.environment.getResourcesPath();
    return [
      resourcesPath ? join(resourcesPath, 'resources', 'agent-workspace-templates', 'main-agent') : '',
      resourcesPath ? join(resourcesPath, 'agent-workspace-templates', 'main-agent') : '',
      join(this.deps.environment.getWorkingDir(), 'resources', 'agent-workspace-templates', 'main-agent'),
      join(this.deps.environment.getOpenClawDirPath(), 'docs', 'reference', 'templates'),
    ].filter((item) => item.trim().length > 0);
  }

  private resolveUpstreamTemplateSnapshotDir(): string {
    return join(this.deps.environment.getOpenClawDirPath(), 'docs', 'reference', UPSTREAM_TEMPLATE_SNAPSHOT_DIRNAME);
  }

  private async firstExistingTemplateDir(candidates: string[]): Promise<string | null> {
    for (const candidate of candidates) {
      if (await this.deps.fileSystem.exists(join(candidate, 'AGENTS.md'))) {
        return candidate;
      }
    }
    return null;
  }

  private async firstExistingFileDir(candidates: string[], fileName: string): Promise<string | null> {
    for (const candidate of candidates) {
      if (await this.deps.fileSystem.exists(join(candidate, fileName))) {
        return candidate;
      }
    }
    return null;
  }

  private async tryReadTextFile(pathname: string): Promise<string | null> {
    try {
      return await this.deps.fileSystem.readTextFile(pathname);
    } catch {
      return null;
    }
  }

  private async readDefaultIdentityContent(): Promise<string> {
    const managedTemplateDir = await this.firstExistingFileDir([
      this.resolveManagedTemplateDir(),
      join(this.deps.environment.getWorkingDir(), 'resources', 'agent-workspace-templates', 'main-agent'),
    ], DEFAULT_IDENTITY_FILE_NAME);
    const managedContent = managedTemplateDir
      ? await this.tryReadTextFile(join(managedTemplateDir, DEFAULT_IDENTITY_FILE_NAME))
      : null;
    return managedContent ?? FALLBACK_IDENTITY_CONTENT;
  }

  private async readUpstreamIdentityTemplate(): Promise<string | null> {
    const upstreamTemplateDir = await this.firstExistingFileDir([
      this.resolveUpstreamTemplateSnapshotDir(),
      join(this.deps.environment.getOpenClawDirPath(), 'docs', 'reference', 'templates'),
    ], DEFAULT_IDENTITY_FILE_NAME);
    return upstreamTemplateDir
      ? await this.tryReadTextFile(join(upstreamTemplateDir, DEFAULT_IDENTITY_FILE_NAME))
      : null;
  }

  private async firstExistingContextDir(): Promise<string | null> {
    const resourcesPath = this.deps.environment.getResourcesPath();
    const candidates = [
      resourcesPath ? join(resourcesPath, 'resources', 'context') : '',
      resourcesPath ? join(resourcesPath, 'context') : '',
      join(this.deps.environment.getWorkingDir(), 'resources', 'context'),
    ].filter((p) => p.length > 0);

    for (const candidate of candidates) {
      if (await this.deps.fileSystem.exists(candidate)) {
        return candidate;
      }
    }
    return null;
  }
}

function normalizeTemplateText(content: string): string {
  return content.replace(/\r\n/g, '\n').trimEnd();
}
