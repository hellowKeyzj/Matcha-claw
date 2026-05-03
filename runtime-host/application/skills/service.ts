import type { OpenClawBridge } from '../../openclaw-bridge';

interface SkillsServiceDeps {
  getAllSkillConfigs: () => Record<string, unknown>;
  updateSkillConfig: (skillKey: string, updates: Record<string, unknown>) => Promise<unknown>;
  setSkillEnabled: (skillKey: string, enabled: boolean) => Promise<unknown>;
  listEffectiveSkills: () => Promise<unknown>;
  openclawBridge: Pick<OpenClawBridge, 'gatewayRpc' | 'isGatewayRunning'>;
}

interface SkillMutationResult {
  success: boolean;
  error?: string;
  syncError?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export class SkillsService {
  constructor(private readonly deps: SkillsServiceDeps) {}

  private async trySyncUpdatesToGateway(
    skillKey: string,
    updates: Record<string, unknown>,
  ): Promise<string | null> {
    let gatewayRunning = false;
    try {
      gatewayRunning = await this.deps.openclawBridge.isGatewayRunning();
    } catch (error) {
      return String(error);
    }
    if (!gatewayRunning) {
      return null;
    }
    try {
      await this.deps.openclawBridge.gatewayRpc('skills.update', {
        skillKey,
        ...updates,
      });
      return null;
    } catch (error) {
      return String(error);
    }
  }

  private async applyUpdates(
    skillKey: string,
    updates: Record<string, unknown>,
    persistLocal: () => Promise<unknown>,
  ): Promise<{
    status: number;
    data: SkillMutationResult;
  }> {
    const localResult = await persistLocal();
    const normalizedLocalResult = isRecord(localResult)
      ? localResult as SkillMutationResult
      : { success: false, error: 'Invalid local skills mutation result' };
    if (normalizedLocalResult.success !== true) {
      return {
        status: 500,
        data: {
          success: false,
          error: normalizedLocalResult.error || 'Failed to persist local skills config',
        },
      };
    }

    const syncError = await this.trySyncUpdatesToGateway(skillKey, updates);
    return {
      status: 200,
      data: syncError
        ? { success: true, syncError }
        : { success: true },
    };
  }

  configs() {
    return this.deps.getAllSkillConfigs();
  }

  async updateConfig(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    const skillKey = typeof body.skillKey === 'string' ? body.skillKey : '';
    if (!skillKey.trim()) {
      return {
        status: 400,
        data: { success: false, error: 'skillKey is required' },
      };
    }
    const updates = {
      ...(typeof body.apiKey === 'string' ? { apiKey: body.apiKey } : {}),
      ...(isRecord(body.env) ? { env: body.env } : {}),
    };
    if (Object.keys(updates).length === 0) {
      return {
        status: 400,
        data: { success: false, error: 'No config updates provided' },
      };
    }
    return await this.applyUpdates(
      skillKey,
      updates,
      async () => await this.deps.updateSkillConfig(skillKey, updates),
    );
  }

  async updateState(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    const skillKey = typeof body.skillKey === 'string' ? body.skillKey : '';
    if (!skillKey.trim()) {
      return {
        status: 400,
        data: { success: false, error: 'skillKey is required' },
      };
    }
    if (typeof body.enabled !== 'boolean') {
      return {
        status: 400,
        data: { success: false, error: 'enabled must be a boolean' },
      };
    }

    return await this.applyUpdates(
      skillKey,
      { enabled: body.enabled },
      async () => await this.deps.setSkillEnabled(skillKey, body.enabled),
    );
  }

  async effective() {
    return {
      success: true,
      tools: await this.deps.listEffectiveSkills(),
    };
  }
}
