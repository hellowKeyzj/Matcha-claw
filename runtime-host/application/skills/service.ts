import type { OpenClawBridge } from '../../openclaw-bridge';

interface SkillsServiceDeps {
  getAllSkillConfigs: () => Record<string, unknown>;
  updateSkillConfig: (skillKey: string, updates: Record<string, unknown>) => Promise<unknown>;
  setSkillEnabled: (skillKey: string, enabled: boolean) => Promise<unknown>;
  listEffectiveSkills: () => Promise<unknown>;
  openclawBridge: Pick<OpenClawBridge, 'gatewayRpc' | 'isGatewayRunning'>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export class SkillsService {
  constructor(private readonly deps: SkillsServiceDeps) {}

  private async applyUpdates(
    skillKey: string,
    updates: Record<string, unknown>,
    localFallback: () => Promise<unknown>,
  ) {
    const gatewayRunning = await this.deps.openclawBridge.isGatewayRunning();
    if (gatewayRunning) {
      await this.deps.openclawBridge.gatewayRpc('skills.update', {
        skillKey,
        ...updates,
      });
      return { success: true };
    }
    return await localFallback();
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
    return {
      status: 200,
      data: await this.applyUpdates(
        skillKey,
        updates,
        async () => await this.deps.updateSkillConfig(skillKey, updates),
      ),
    };
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

    return {
      status: 200,
      data: await this.applyUpdates(
        skillKey,
        { enabled: body.enabled },
        async () => await this.deps.setSkillEnabled(skillKey, body.enabled),
      ),
    };
  }

  async effective() {
    return {
      success: true,
      tools: await this.deps.listEffectiveSkills(),
    };
  }
}
