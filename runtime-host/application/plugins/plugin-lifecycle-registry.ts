import type {
  RuntimePluginConfigLifecycleContext,
  RuntimePluginLifecycle,
  RuntimePluginSideEffectLifecycleContext,
  RuntimePluginStartupConfigLifecycleContext,
  RuntimePluginStartupSideEffectLifecycleContext,
  RuntimePluginTransitionLifecycleState,
} from './plugin-lifecycle-types';
import { memoryLancedbProLifecycle } from './plugin-lifecycles/memory-lancedb-pro-lifecycle';

const REGISTERED_PLUGIN_LIFECYCLES: readonly RuntimePluginLifecycle[] = [
  memoryLancedbProLifecycle,
];

const lifecycleByPluginId = new Map(
  REGISTERED_PLUGIN_LIFECYCLES.map((lifecycle) => [lifecycle.id, lifecycle] as const),
);

async function applyConfigLifecycle(
  config: Record<string, unknown>,
  pluginId: string,
  handler: 'onEnableConfig' | 'onDisableConfig',
  state: RuntimePluginTransitionLifecycleState,
): Promise<Record<string, unknown>> {
  const lifecycle = lifecycleByPluginId.get(pluginId);
  const apply = lifecycle?.[handler];
  if (!apply) {
    return config;
  }
  const context: RuntimePluginConfigLifecycleContext = {
    pluginId,
    ...state,
  };
  return await apply(config, context);
}

async function runSideEffectLifecycle(
  pluginId: string,
  handler: 'onEnable' | 'onDisable',
  state: RuntimePluginTransitionLifecycleState,
): Promise<void> {
  const lifecycle = lifecycleByPluginId.get(pluginId);
  const run = lifecycle?.[handler];
  if (!run) {
    return;
  }
  const context: RuntimePluginSideEffectLifecycleContext = {
    pluginId,
    ...state,
  };
  await run(context);
}

async function applyStartupConfigLifecycle(
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

async function runStartupSideEffectLifecycle(
  pluginId: string,
  enabledPluginIds: readonly string[],
): Promise<void> {
  const lifecycle = lifecycleByPluginId.get(pluginId);
  const run = lifecycle?.onStartup;
  if (!run) {
    return;
  }
  const context: RuntimePluginStartupSideEffectLifecycleContext = {
    pluginId,
    enabledPluginIds,
  };
  await run(context);
}

export async function applyPluginTransitionConfigLifecycles(
  config: Record<string, unknown>,
  state: RuntimePluginTransitionLifecycleState,
): Promise<Record<string, unknown>> {
  let nextConfig = config;

  for (const pluginId of state.newlyEnabledPluginIds) {
    nextConfig = await applyConfigLifecycle(nextConfig, pluginId, 'onEnableConfig', state);
  }

  for (const pluginId of state.newlyDisabledPluginIds) {
    nextConfig = await applyConfigLifecycle(nextConfig, pluginId, 'onDisableConfig', state);
  }

  return nextConfig;
}

export async function runPluginTransitionSideEffectLifecycles(
  state: RuntimePluginTransitionLifecycleState,
): Promise<void> {
  for (const pluginId of state.newlyEnabledPluginIds) {
    await runSideEffectLifecycle(pluginId, 'onEnable', state);
  }

  for (const pluginId of state.newlyDisabledPluginIds) {
    await runSideEffectLifecycle(pluginId, 'onDisable', state);
  }
}

export async function applyPluginStartupConfigLifecycles(
  config: Record<string, unknown>,
  enabledPluginIds: readonly string[],
): Promise<Record<string, unknown>> {
  let nextConfig = config;

  for (const pluginId of enabledPluginIds) {
    nextConfig = await applyStartupConfigLifecycle(nextConfig, pluginId, enabledPluginIds);
  }

  return nextConfig;
}

export async function runPluginStartupSideEffectLifecycles(
  enabledPluginIds: readonly string[],
): Promise<void> {
  for (const pluginId of enabledPluginIds) {
    await runStartupSideEffectLifecycle(pluginId, enabledPluginIds);
  }
}
