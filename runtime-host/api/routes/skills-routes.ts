import { SkillsService } from '../../application/skills/service';

interface LocalDispatchResponse {
  status: number;
  data: unknown;
}

interface SkillsRouteDeps {
  getAllSkillConfigsLocal: () => Record<string, unknown>;
  updateSkillConfigLocal: (skillKey: string, updates: Record<string, unknown>) => Promise<unknown>;
  listEffectiveSkillsLocal: () => Promise<unknown>;
}

export async function handleSkillsRoute(
  method: string,
  routePath: string,
  payload: unknown,
  deps: SkillsRouteDeps,
): Promise<LocalDispatchResponse | null> {
  const service = new SkillsService({
    getAllSkillConfigs: deps.getAllSkillConfigsLocal,
    updateSkillConfig: deps.updateSkillConfigLocal,
    listEffectiveSkills: deps.listEffectiveSkillsLocal,
  });

  if (method === 'GET' && routePath === '/api/skills/configs') {
    return {
      status: 200,
      data: service.configs(),
    };
  }

  if (method === 'PUT' && routePath === '/api/skills/config') {
    return await service.updateConfig(payload);
  }

  if (method === 'GET' && routePath === '/api/skills/effective') {
    try {
      return {
        status: 200,
        data: await service.effective(),
      };
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  return null;
}
