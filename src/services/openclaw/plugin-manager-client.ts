import { hostApiFetch } from '@/lib/host-api';
import { configurePlugin } from '@/lib/plugins';

export type RuntimePluginCatalogItem = {
  id: string;
  name: string;
  version: string;
  kind: 'builtin' | 'third-party';
  platform: 'openclaw' | 'matchaclaw';
  category: string;
  group: 'channel' | 'model' | 'general';
  description?: string;
  enabled: boolean;
  controlMode?: 'manual';
  source?: 'workspace' | 'bundled' | 'openclaw-extension' | 'matchaclaw-extension';
  companionSkillSlugs?: string[];
};

type PluginCatalogPayload = {
  success: boolean;
  execution: {
    enabledPluginIds: string[];
  };
  plugins: RuntimePluginCatalogItem[];
};

type PluginRuntimePayload = {
  success: boolean;
  execution: {
    enabledPluginIds: string[];
  };
};

export async function getPluginCatalog(): Promise<PluginCatalogPayload> {
  return await hostApiFetch<PluginCatalogPayload>('/api/plugins/catalog');
}

export async function getPluginRuntime(): Promise<PluginRuntimePayload> {
  return await hostApiFetch<PluginRuntimePayload>('/api/plugins/runtime');
}

export async function setEnabledPluginIds(pluginIds: string[]): Promise<PluginRuntimePayload> {
  if (pluginIds.length !== 1) {
    throw new Error('setEnabledPluginIds requires exactly one pluginId');
  }
  const outcome = await configurePlugin(pluginIds[0], true);
  if (outcome !== 'configured') {
    throw new Error('Plugin configuration was not accepted');
  }
  return await getPluginRuntime();
}

export async function ensurePluginEnabled(pluginId: string): Promise<PluginRuntimePayload> {
  const runtime = await getPluginRuntime();
  if (runtime.execution.enabledPluginIds.includes(pluginId)) {
    return runtime;
  }
  return await setEnabledPluginIds([pluginId]);
}
