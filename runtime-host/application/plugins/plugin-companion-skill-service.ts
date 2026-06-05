import type { PluginCompanionSkillWorkflow } from '../workflows/plugin-lifecycle/plugin-companion-skill-workflow';
export type { PluginCompanionSkillWorkspacePort } from '../workflows/plugin-lifecycle/plugin-companion-skill-workflow';

export class PluginCompanionSkillService {
  constructor(
    private readonly companionSkillWorkflow: Pick<PluginCompanionSkillWorkflow,
      | 'getSlugsForPlugin'
      | 'applyConfigState'
      | 'reconcileConfigStates'
      | 'ensureInstalled'
    >,
  ) {}

  getSlugsForPlugin(pluginId: string): readonly string[] {
    return this.companionSkillWorkflow.getSlugsForPlugin(pluginId);
  }

  applyConfigState(
    config: Record<string, unknown>,
    pluginId: string,
    enabled: boolean,
  ): Record<string, unknown> {
    return this.companionSkillWorkflow.applyConfigState(config, pluginId, enabled);
  }

  reconcileConfigStates(
    config: Record<string, unknown>,
    enabledPluginIds: readonly string[],
  ): Record<string, unknown> {
    return this.companionSkillWorkflow.reconcileConfigStates(config, enabledPluginIds);
  }

  async ensureInstalled(pluginId: string): Promise<void> {
    await this.companionSkillWorkflow.ensureInstalled(pluginId);
  }
}
