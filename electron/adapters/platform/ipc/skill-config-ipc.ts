import { ipcMain } from 'electron';
import { updateSkillConfig, getSkillConfig, getAllSkillConfigs } from '../../../utils/skill-config';

export function registerSkillConfigHandlers(): void {
  // Update skill config (apiKey and env)
  ipcMain.handle('skill:updateConfig', async (_, params: {
    skillKey: string;
    apiKey?: string;
    env?: Record<string, string>;
  }) => {
    return await updateSkillConfig(params.skillKey, {
      apiKey: params.apiKey,
      env: params.env,
    });
  });

  // Get skill config
  ipcMain.handle('skill:getConfig', async (_, skillKey: string) => {
    return await getSkillConfig(skillKey);
  });

  // Get all skill configs
  ipcMain.handle('skill:getAllConfigs', async () => {
    return await getAllSkillConfigs();
  });
}