import { hostApiFetch } from '@/lib/host-api';
import type { PluginGroupId } from '@/features/plugins/plugin-groups';

export type RuntimePluginCatalogItem = {
  id: string;
  name: string;
  version: string;
  kind: 'builtin' | 'third-party';
  platform: 'openclaw' | 'matchaclaw';
  category: string;
  group: PluginGroupId;
  description?: string;
  enabled: boolean;
  controlMode?: 'manual' | 'channel-config';
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
  return await hostApiFetch<PluginRuntimePayload>('/api/plugins/runtime/enabled-plugins', {
    method: 'PUT',
    body: JSON.stringify({ pluginIds }),
  });
}

export async function ensurePluginEnabled(pluginId: string): Promise<PluginRuntimePayload> {
  const runtime = await getPluginRuntime();
  if (runtime.execution.enabledPluginIds.includes(pluginId)) {
    return runtime;
  }
  return await setEnabledPluginIds([...runtime.execution.enabledPluginIds, pluginId]);
}
