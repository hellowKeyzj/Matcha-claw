import { dirname, join } from 'node:path';
import type { OpenClawEnvironmentRepository } from './openclaw-environment-repository';
import type { OpenClawProviderSnapshotService } from './openclaw-provider-snapshot';
import type { OpenClawConfigRepositoryPort } from './openclaw-config-repository';
import type { OpenClawWorkspacePort } from './openclaw-workspace-service';
import type { SubagentTemplateService } from './templates';

export interface OpenClawServiceDeps {
  readonly config: Pick<OpenClawConfigRepositoryPort, 'getOpenClawDirPath'>;
  readonly environment: Pick<OpenClawEnvironmentRepository, 'getOpenClawStatus' | 'getPlatform' | 'pathExists'>;
  readonly workspace: OpenClawWorkspacePort;
  readonly subagentTemplates: Pick<SubagentTemplateService, 'listCatalog' | 'getTemplate'>;
  readonly providerSnapshot: Pick<OpenClawProviderSnapshotService, 'getActiveProviders' | 'getProvidersConfig'>;
}

export class OpenClawService {
  constructor(private readonly deps: OpenClawServiceDeps) {}

  async status() {
    return await this.deps.environment.getOpenClawStatus();
  }

  async ready() {
    return (await this.deps.environment.getOpenClawStatus()).packageExists;
  }

  dir() {
    return this.deps.config.getOpenClawDirPath();
  }

  configDir() {
    return this.deps.workspace.getConfigDir();
  }

  async subagentTemplates() {
    return await this.deps.subagentTemplates.listCatalog();
  }

  async subagentTemplate(templateIdRaw: string) {
    let templateId = '';
    try {
      templateId = decodeURIComponent(templateIdRaw);
    } catch {
      templateId = templateIdRaw;
    }
    return await this.deps.subagentTemplates.getTemplate(templateId);
  }

  async workspaceDir() {
    return await this.deps.workspace.getMainWorkspaceDir();
  }

  async taskWorkspaceDirs() {
    return await this.deps.workspace.getTaskWorkspaceDirs();
  }

  async activeProviders() {
    return await this.deps.providerSnapshot.getActiveProviders();
  }

  async providersConfig() {
    return await this.deps.providerSnapshot.getProvidersConfig();
  }

  skillsDir() {
    return this.deps.workspace.getSkillsDir();
  }

  async cliCommand() {
    const status = await this.deps.environment.getOpenClawStatus();
    if (!status.packageExists) {
      return { success: false, error: `OpenClaw package not found at: ${status.dir}` };
    }
    if (!(await this.deps.environment.pathExists(status.entryPath))) {
      return { success: false, error: `OpenClaw entry script not found at: ${status.entryPath}` };
    }
    const platform = this.deps.environment.getPlatform();
    const binName = platform === 'win32' ? 'openclaw.cmd' : 'openclaw';
    const binPath = join(dirname(status.dir), '.bin', binName);
    if (await this.deps.environment.pathExists(binPath)) {
      if (platform === 'win32') {
        return { success: true, command: `& '${binPath}'` };
      }
      return { success: true, command: `"${binPath}"` };
    }
    if (platform === 'win32') {
      return { success: true, command: `node '${status.entryPath}'` };
    }
    return { success: true, command: `node "${status.entryPath}"` };
  }
}
