import { hostApiFetch } from '@/lib/host-api';

export type RuntimePluginCatalogItem = {
  id: string;
  name: string;
  version: string;
  kind: 'builtin' | 'third-party';
  platform: 'openclaw' | 'matchaclaw';
  category: string;
  description?: string;
  enabled: boolean;
  skillIds?: string[];
};

type PluginCatalogPayload = {
  success: boolean;
  execution: {
    pluginExecutionEnabled: boolean;
    enabledPluginIds: string[];
  };
  plugins: RuntimePluginCatalogItem[];
};

type PluginRuntimePayload = {
  success: boolean;
  execution: {
    pluginExecutionEnabled: boolean;
    enabledPluginIds: string[];
  };
};

export async function getPluginCatalog(): Promise<PluginCatalogPayload> {
  return await hostApiFetch<PluginCatalogPayload>('/api/plugins/catalog');
}

export async function getPluginRuntime(): Promise<PluginRuntimePayload> {
  return await hostApiFetch<PluginRuntimePayload>('/api/plugins/runtime');
}

export async function setPluginExecutionEnabled(enabled: boolean): Promise<PluginRuntimePayload> {
  return await hostApiFetch<PluginRuntimePayload>('/api/plugins/runtime/execution', {
    method: 'PUT',
    body: JSON.stringify({ enabled }),
  });
}

export async function setEnabledPluginIds(pluginIds: string[]): Promise<PluginRuntimePayload> {
  return await hostApiFetch<PluginRuntimePayload>('/api/plugins/runtime/enabled-plugins', {
    method: 'PUT',
    body: JSON.stringify({ pluginIds }),
  });
}

export async function ensurePluginEnabled(pluginId: string): Promise<PluginRuntimePayload> {
  const runtime = await getPluginRuntime();
  let current = runtime;
  if (!current.execution.pluginExecutionEnabled) {
    current = await setPluginExecutionEnabled(true);
  }
  if (current.execution.enabledPluginIds.includes(pluginId)) {
    return current;
  }
  return await setEnabledPluginIds([...current.execution.enabledPluginIds, pluginId]);
}
