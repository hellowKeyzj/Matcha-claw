import {
  accepted,
  badRequest,
  ok,
  serverError,
  type ApplicationResponse,
} from '../../common/application-response';
import type { SkillReadmePreviewRepository, SkillsConfigRepository } from '../../skills/store';
import type { SkillsJobPort } from '../../skills/skills-jobs';
import type { SkillRuntimeWorkflow } from './skill-runtime-workflow';
import type { LocalSkillImportResult, LocalSkillImportWorkflow } from '../skill-install/local-skill-import-workflow';
import type { SkillBundleTransferWorkflow } from '../skill-install/skill-bundle-transfer-workflow';
import type { RuntimeHostLogger } from '../../../shared/logger';

export interface SkillsOperationsWorkflowDeps {
  readonly repository: Pick<SkillsConfigRepository, 'updateConfig' | 'setEnabled' | 'setManyEnabled' | 'listEffective'>;
  readonly readmePreviews: Pick<SkillReadmePreviewRepository, 'read'>;
  readonly jobs: SkillsJobPort;
  readonly skillRuntimeWorkflow: Pick<SkillRuntimeWorkflow, 'refreshStatus' | 'validateCanonicalSkillKeys'>;
  readonly skillBundleTransferWorkflow: Pick<SkillBundleTransferWorkflow, 'importBundles'>;
  readonly localSkillImportWorkflow: Pick<LocalSkillImportWorkflow, 'execute'>;
  readonly logger: RuntimeHostLogger;
}

interface SkillMutationResult {
  success: boolean;
  error?: string;
  syncError?: string;
}

export class SkillsOperationsWorkflow {
  constructor(private readonly deps: SkillsOperationsWorkflowDeps) {}

  importLocal(payload: unknown): ApplicationResponse {
    const sourcePath = this.readRequiredSourcePath(payload);
    if (!sourcePath) {
      return badRequest('sourcePath is required');
    }
    return accepted(this.deps.jobs.submitImportLocal({ sourcePath }));
  }

  async executeImportLocal(payload: unknown): Promise<LocalSkillImportResult> {
    const sourcePath = this.readRequiredSourcePath(payload);
    if (!sourcePath) {
      throw new Error('sourcePath is required');
    }
    return await this.deps.localSkillImportWorkflow.execute({ sourcePath });
  }

  async importBundles(payload: unknown): Promise<ApplicationResponse> {
    try {
      return ok(await this.deps.skillBundleTransferWorkflow.importBundles(payload));
    } catch (error) {
      return serverError(error instanceof Error ? error.message : String(error));
    }
  }

  ensurePreinstalled(): ApplicationResponse {
    return accepted(this.deps.jobs.submitEnsurePreinstalled());
  }

  async updateConfig(payload: unknown): Promise<ApplicationResponse> {
    const body = isRecord(payload) ? payload : {};
    const skillKey = typeof body.skillKey === 'string' ? body.skillKey : '';
    if (!skillKey.trim()) {
      return badRequest('skillKey is required');
    }
    const updates = {
      ...(typeof body.apiKey === 'string' ? { apiKey: body.apiKey } : {}),
      ...(isRecord(body.env) ? { env: body.env } : {}),
    };
    if (Object.keys(updates).length === 0) {
      return badRequest('No config updates provided');
    }
    const validatedSkillKey = await this.validateSingleSkillKey(skillKey);
    if (!validatedSkillKey.ok) {
      return badRequest(validatedSkillKey.error);
    }
    return await this.applyUpdates(
      validatedSkillKey.skillKey,
      updates,
      async () => await this.deps.repository.updateConfig(validatedSkillKey.skillKey, updates),
    );
  }

  async updateState(payload: unknown): Promise<ApplicationResponse> {
    const body = isRecord(payload) ? payload : {};
    const skillKey = typeof body.skillKey === 'string' ? body.skillKey : '';
    if (!skillKey.trim()) {
      return badRequest('skillKey is required');
    }
    if (typeof body.enabled !== 'boolean') {
      return badRequest('enabled must be a boolean');
    }
    const validatedSkillKey = await this.validateSingleSkillKey(skillKey);
    if (!validatedSkillKey.ok) {
      return badRequest(validatedSkillKey.error);
    }

    return await this.applyUpdates(
      validatedSkillKey.skillKey,
      { enabled: body.enabled },
      async () => await this.deps.repository.setEnabled(validatedSkillKey.skillKey, Boolean(body.enabled)),
    );
  }

  async updateBatchState(payload: unknown): Promise<ApplicationResponse> {
    const body = isRecord(payload) ? payload : {};
    if (!Array.isArray(body.skillKeys)) {
      return badRequest('skillKeys is required');
    }
    const skillKeys = [...new Set(body.skillKeys
      .map((skillKey) => typeof skillKey === 'string' ? skillKey.trim() : '')
      .filter(Boolean))];
    if (skillKeys.length === 0) {
      return badRequest('skillKeys is required');
    }
    if (typeof body.enabled !== 'boolean') {
      return badRequest('enabled must be a boolean');
    }
    const validatedSkillKeys = await this.deps.skillRuntimeWorkflow.validateCanonicalSkillKeys(skillKeys);
    if (!validatedSkillKeys.ok) {
      return badRequest(validatedSkillKeys.error);
    }

    const localResult = await this.deps.repository.setManyEnabled(validatedSkillKeys.skillKeys, body.enabled);
    if (localResult.success !== true) {
      return serverError(localResult.error || 'Failed to persist local skills config');
    }
    try {
      await this.deps.skillRuntimeWorkflow.refreshStatus();
    } catch (error) {
      this.deps.logger.warn(`Failed to refresh skills after batch state update: ${String(error)}`);
    }

    return ok({
      success: true,
      updated: validatedSkillKeys.skillKeys,
      enabled: body.enabled,
    });
  }

  async effective(): Promise<{ success: true; tools: unknown }> {
    return {
      success: true,
      tools: await this.deps.repository.listEffective(),
    };
  }

  async readmePreview(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    const skillKey = typeof body.skillKey === 'string' ? body.skillKey.trim() : '';
    if (!skillKey) {
      return badRequest('skillKey is required');
    }

    return await this.deps.readmePreviews.read(skillKey, {
      filePath: typeof body.filePath === 'string' ? body.filePath : undefined,
      baseDir: typeof body.baseDir === 'string' ? body.baseDir : undefined,
    });
  }

  private readRequiredSourcePath(payload: unknown): string {
    const body = isRecord(payload) ? payload : {};
    return typeof body.sourcePath === 'string' ? body.sourcePath.trim() : '';
  }

  private async validateSingleSkillKey(skillKey: string): Promise<
    { ok: true; skillKey: string }
    | { ok: false; error: string }
  > {
    const validatedSkillKeys = await this.deps.skillRuntimeWorkflow.validateCanonicalSkillKeys([skillKey.trim()]);
    if (!validatedSkillKeys.ok) {
      return validatedSkillKeys;
    }
    const [validatedSkillKey] = validatedSkillKeys.skillKeys;
    if (!validatedSkillKey) {
      return { ok: false, error: `Unknown skillKey: ${skillKey.trim()}` };
    }
    return { ok: true, skillKey: validatedSkillKey };
  }

  private async applyUpdates(
    skillKey: string,
    updates: Record<string, unknown>,
    persistLocal: () => Promise<unknown>,
  ): Promise<ApplicationResponse> {
    const localResult = await persistLocal();
    const normalizedLocalResult = isRecord(localResult) && typeof localResult.success === 'boolean'
      ? localResult as unknown as SkillMutationResult
      : { success: false, error: 'Invalid local skills mutation result' };
    if (normalizedLocalResult.success !== true) {
      return serverError(normalizedLocalResult.error || 'Failed to persist local skills config');
    }

    return accepted(this.deps.jobs.submitGatewayUpdate({ skillKey, updates }));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
