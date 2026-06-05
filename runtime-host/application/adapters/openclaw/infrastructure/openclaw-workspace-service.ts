import type { ContextMergeResult } from './openclaw-workspace-context-merge';
import type { OpenClawWorkspaceMaintenanceWorkflow } from '../workflows/openclaw-workspace/openclaw-workspace-maintenance-workflow';
import type { OpenClawWorkspaceQueryWorkflow } from '../workflows/openclaw-workspace/openclaw-workspace-query-workflow';

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

export class OpenClawWorkspaceService implements OpenClawWorkspacePort {
  constructor(
    private readonly queryWorkflow: Pick<OpenClawWorkspaceQueryWorkflow,
      | 'getConfigDir'
      | 'getSkillsDir'
      | 'getDefaultSkillReadmePath'
      | 'getPreviewRoots'
      | 'getMainWorkspaceDir'
      | 'getWorkspaceDirForSession'
      | 'getTaskWorkspaceDirs'
    >,
    private readonly maintenanceWorkflow: Pick<OpenClawWorkspaceMaintenanceWorkflow,
      | 'ensureIdentityFile'
      | 'ensureDefaultIdentity'
      | 'migrateMainAgentTemplatesIfNeeded'
      | 'mergeContextSnippets'
    >,
  ) {}

  getConfigDir(): string {
    return this.queryWorkflow.getConfigDir();
  }

  getSkillsDir(): string {
    return this.queryWorkflow.getSkillsDir();
  }

  getDefaultSkillReadmePath(skillKey: string): string {
    return this.queryWorkflow.getDefaultSkillReadmePath(skillKey);
  }

  async getPreviewRoots(): Promise<string[]> {
    return await this.queryWorkflow.getPreviewRoots();
  }

  async getMainWorkspaceDir(): Promise<string> {
    return await this.queryWorkflow.getMainWorkspaceDir();
  }

  async getWorkspaceDirForSession(sessionKey: string): Promise<string> {
    return await this.queryWorkflow.getWorkspaceDirForSession(sessionKey);
  }

  async getTaskWorkspaceDirs(): Promise<string[]> {
    return await this.queryWorkflow.getTaskWorkspaceDirs();
  }

  async ensureIdentityFile(
    workspaceDir: string,
    options: { createDir?: boolean } = {},
  ): Promise<{ wroteIdentity: boolean; replacedTemplate: boolean; removedBootstrap: boolean }> {
    return await this.maintenanceWorkflow.ensureIdentityFile(workspaceDir, options);
  }

  async ensureDefaultIdentity(): Promise<{ workspaceDirs: string[]; seededFiles: string[]; replacedTemplateFiles: string[]; removedBootstrapFiles: string[] }> {
    return await this.maintenanceWorkflow.ensureDefaultIdentity();
  }

  async migrateMainAgentTemplatesIfNeeded(): Promise<{ workspaceDir: string; migratedFiles: string[] }> {
    return await this.maintenanceWorkflow.migrateMainAgentTemplatesIfNeeded();
  }

  async mergeContextSnippets(): Promise<ContextMergeResult> {
    return await this.maintenanceWorkflow.mergeContextSnippets();
  }
}
