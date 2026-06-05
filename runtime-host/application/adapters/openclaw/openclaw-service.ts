import type { OpenClawEnvironmentRepository } from './infrastructure/openclaw-environment-repository';
import type { OpenClawProviderSnapshotService } from './projections/openclaw-provider-snapshot';
import type { OpenClawConfigRepositoryPort } from './infrastructure/openclaw-config-repository';
import type { OpenClawWorkspacePort } from './infrastructure/openclaw-workspace-service';
import type { SubagentTemplateService } from './infrastructure/openclaw-subagent-template-service';
import type { OpenClawCliCommandWorkflow } from './workflows/openclaw-workspace/openclaw-cli-command-workflow';

export interface OpenClawServiceDeps {
  readonly config: Pick<OpenClawConfigRepositoryPort, 'getOpenClawDirPath'>;
  readonly environment: Pick<OpenClawEnvironmentRepository, 'getOpenClawStatus'>;
  readonly cliCommandWorkflow: Pick<OpenClawCliCommandWorkflow, 'cliCommand'>;
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
    return await this.deps.cliCommandWorkflow.cliCommand();
  }
}
