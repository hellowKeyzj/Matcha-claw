interface SkillsServiceDeps {
  getAllSkillConfigs: () => Record<string, unknown>;
  updateSkillConfig: (skillKey: string, updates: Record<string, unknown>) => Promise<unknown>;
  listEffectiveSkills: () => Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export class SkillsService {
  constructor(private readonly deps: SkillsServiceDeps) {}

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
    return {
      status: 200,
      data: await this.deps.updateSkillConfig(skillKey, updates),
    };
  }

  async effective() {
    return {
      success: true,
      tools: await this.deps.listEffectiveSkills(),
    };
  }
}
