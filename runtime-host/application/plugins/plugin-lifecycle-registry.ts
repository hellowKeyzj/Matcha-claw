import type {
  RuntimePluginConfigLifecycleContext,
  RuntimePluginLifecycle,
  RuntimePluginSideEffectLifecycleContext,
  RuntimePluginStartupConfigLifecycleContext,
  RuntimePluginStartupSideEffectLifecycleContext,
  RuntimePluginTransitionLifecycleState,
} from './plugin-lifecycle-types';
import type { PluginCompanionSkillService } from './plugin-companion-skill-service';
import { memoryLancedbProLifecycle } from './plugin-lifecycles/memory-lancedb-pro-lifecycle';

const REGISTERED_PLUGIN_LIFECYCLES: readonly RuntimePluginLifecycle[] = [
  memoryLancedbProLifecycle,
];

const lifecycleByPluginId = new Map(
  REGISTERED_PLUGIN_LIFECYCLES.map((lifecycle) => [lifecycle.id, lifecycle] as const),
);

export class RuntimePluginLifecycleRunner {
  constructor(private readonly companionSkills: PluginCompanionSkillService) {}

  async applyTransitionConfig(
    config: Record<string, unknown>,
    state: RuntimePluginTransitionLifecycleState,
  ): Promise<Record<string, unknown>> {
    let nextConfig = config;

    for (const pluginId of state.newlyEnabledPluginIds) {
      nextConfig = await this.applyConfigLifecycle(nextConfig, pluginId, 'onEnableConfig', state);
    }

    for (const pluginId of state.newlyDisabledPluginIds) {
      nextConfig = await this.applyConfigLifecycle(nextConfig, pluginId, 'onDisableConfig', state);
    }

    return nextConfig;
  }

  async runTransitionSideEffects(state: RuntimePluginTransitionLifecycleState): Promise<void> {
    for (const pluginId of state.newlyEnabledPluginIds) {
      await this.runSideEffectLifecycle(pluginId, 'onEnable', state);
    }

    for (const pluginId of state.newlyDisabledPluginIds) {
      await this.runSideEffectLifecycle(pluginId, 'onDisable', state);
    }
  }

  async applyStartupConfig(
    config: Record<string, unknown>,
    enabledPluginIds: readonly string[],
  ): Promise<Record<string, unknown>> {
    let nextConfig = config;

    for (const pluginId of enabledPluginIds) {
      nextConfig = await this.applyStartupConfigLifecycle(nextConfig, pluginId, enabledPluginIds);
    }

    return this.companionSkills.reconcileConfigStates(nextConfig, enabledPluginIds);
  }

  async runStartupSideEffects(enabledPluginIds: readonly string[]): Promise<void> {
    for (const pluginId of enabledPluginIds) {
      await this.runStartupSideEffectLifecycle(pluginId, enabledPluginIds);
    }
  }

  private async applyConfigLifecycle(
    config: Record<string, unknown>,
    pluginId: string,
    handler: 'onEnableConfig' | 'onDisableConfig',
    state: RuntimePluginTransitionLifecycleState,
  ): Promise<Record<string, unknown>> {
    const lifecycle = lifecycleByPluginId.get(pluginId);
    const apply = lifecycle?.[handler];
    let nextConfig = config;
    if (apply) {
      const context: RuntimePluginConfigLifecycleContext = {
        pluginId,
        ...state,
      };
      nextConfig = await apply(config, context);
    }
    return this.companionSkills.applyConfigState(nextConfig, pluginId, handler === 'onEnableConfig');
  }

  private async runSideEffectLifecycle(
    pluginId: string,
    handler: 'onEnable' | 'onDisable',
    state: RuntimePluginTransitionLifecycleState,
  ): Promise<void> {
    const lifecycle = lifecycleByPluginId.get(pluginId);
    const run = lifecycle?.[handler];
    if (run) {
      const context: RuntimePluginSideEffectLifecycleContext = {
        pluginId,
        ...state,
      };
      await run(context);
    }
    if (handler === 'onEnable') {
      await this.companionSkills.ensureInstalled(pluginId);
    }
  }

  private async applyStartupConfigLifecycle(
    config: Record<string, unknown>,
    pluginId: string,
    enabledPluginIds: readonly string[],
  ): Promise<Record<string, unknown>> {
    const lifecycle = lifecycleByPluginId.get(pluginId);
    const apply = lifecycle?.onStartupConfig;
    if (!apply) {
      return config;
    }
    const context: RuntimePluginStartupConfigLifecycleContext = {
      pluginId,
      enabledPluginIds,
    };
    return await apply(config, context);
  }

  private async runStartupSideEffectLifecycle(
    pluginId: string,
    enabledPluginIds: readonly string[],
  ): Promise<void> {
    const lifecycle = lifecycleByPluginId.get(pluginId);
    const run = lifecycle?.onStartup;
    if (run) {
      const context: RuntimePluginStartupSideEffectLifecycleContext = {
        pluginId,
        enabledPluginIds,
      };
      await run(context);
    }
    await this.companionSkills.ensureInstalled(pluginId);
  }
}
