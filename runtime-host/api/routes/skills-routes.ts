import type { OpenClawBridge } from '../../openclaw-bridge';
import { SkillsService } from '../../application/skills/service';

interface LocalDispatchResponse {
  status: number;
  data: unknown;
}

interface SkillsRouteDeps {
  getAllSkillConfigsLocal: () => Record<string, unknown>;
  updateSkillConfigLocal: (skillKey: string, updates: Record<string, unknown>) => Promise<unknown>;
  setSkillEnabledLocal: (skillKey: string, enabled: boolean) => Promise<unknown>;
  listEffectiveSkillsLocal: () => Promise<unknown>;
  openclawBridge: Pick<OpenClawBridge, 'gatewayRpc' | 'isGatewayRunning'>;
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
    setSkillEnabled: deps.setSkillEnabledLocal,
    listEffectiveSkills: deps.listEffectiveSkillsLocal,
    openclawBridge: deps.openclawBridge,
  });

  if (method === 'GET' && routePath === '/api/skills/configs') {
    return {
      status: 200,
      data: service.configs(),
    };
  }

  if (method === 'PUT' && routePath === '/api/skills/config') {
    try {
      return await service.updateConfig(payload);
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  if (method === 'PUT' && routePath === '/api/skills/state') {
    try {
      return await service.updateState(payload);
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
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
