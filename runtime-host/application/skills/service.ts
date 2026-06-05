import type { ApplicationResponse } from '../common/application-response';
import type {
  LocalSkillImportResult,
  LocalSkillImportWorkflow,
} from '../workflows/skill-install/local-skill-import-workflow';
import type {
  SkillBundle,
  SkillBundleTransferWorkflow,
} from '../workflows/skill-install/skill-bundle-transfer-workflow';
import type { PreinstalledSkillsWorkflow } from '../workflows/skill-install/preinstalled-skills-workflow';
import type { SkillsOperationsWorkflow } from '../workflows/skill-runtime/skills-operations-workflow';
import type { SkillRuntimeWorkflow } from '../workflows/skill-runtime/skill-runtime-workflow';

export interface SkillsWorkspacePort {
  getSkillsDir(): string;
  getBuiltinVisibleSkillsManifestCandidates(): readonly string[];
  getBuiltinSkillRootCandidates(): readonly string[];
  getPreinstalledManifestCandidates(): readonly string[];
  getPreinstalledSourceRootCandidates(): readonly string[];
}

interface SkillsServiceDeps {
  operationsWorkflow: Pick<
    SkillsOperationsWorkflow,
    'importLocal' | 'executeImportLocal' | 'importBundles' | 'ensurePreinstalled' | 'updateConfig' | 'updateState' | 'updateBatchState' | 'effective' | 'readmePreview'
  >;
  skillRuntimeWorkflow: Pick<SkillRuntimeWorkflow, 'status' | 'refreshStatus' | 'executeGatewayUpdate'>;
  skillBundleTransferWorkflow: Pick<SkillBundleTransferWorkflow, 'exportBundles' | 'importBundles'>;
  preinstalledSkillsWorkflow: Pick<PreinstalledSkillsWorkflow, 'execute'>;
}

export class SkillsService {
  constructor(private readonly deps: SkillsServiceDeps) {}

  async status() {
    return await this.deps.skillRuntimeWorkflow.status();
  }

  async refreshStatus() {
    return await this.deps.skillRuntimeWorkflow.refreshStatus();
  }

  async executeGatewayUpdate(
    skillKey: string,
    updates: Record<string, unknown>,
  ): Promise<string | null> {
    return await this.deps.skillRuntimeWorkflow.executeGatewayUpdate(skillKey, updates);
  }

  importLocal(payload: unknown): ApplicationResponse {
    return this.deps.operationsWorkflow.importLocal(payload);
  }

  async executeImportLocal(payload: unknown): Promise<LocalSkillImportResult> {
    return await this.deps.operationsWorkflow.executeImportLocal(payload);
  }

  async exportBundles(payload: unknown): Promise<SkillBundle[]> {
    return await this.deps.skillBundleTransferWorkflow.exportBundles(payload);
  }

  async importBundles(payload: unknown): Promise<ApplicationResponse> {
    return await this.deps.operationsWorkflow.importBundles(payload);
  }

  ensurePreinstalled(): ApplicationResponse {
    return this.deps.operationsWorkflow.ensurePreinstalled();
  }

  async executeEnsurePreinstalled() {
    return await this.deps.preinstalledSkillsWorkflow.execute();
  }

  async updateConfig(payload: unknown): Promise<ApplicationResponse> {
    return await this.deps.operationsWorkflow.updateConfig(payload);
  }

  async updateState(payload: unknown): Promise<ApplicationResponse> {
    return await this.deps.operationsWorkflow.updateState(payload);
  }

  async updateBatchState(payload: unknown): Promise<ApplicationResponse> {
    return await this.deps.operationsWorkflow.updateBatchState(payload);
  }

  async effective() {
    return await this.deps.operationsWorkflow.effective();
  }

  async readmePreview(payload: unknown) {
    return await this.deps.operationsWorkflow.readmePreview(payload);
  }
}
