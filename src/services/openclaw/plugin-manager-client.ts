import { hostApiFetch, resolveSingleCapabilityScope, waitForRuntimeJobResult, type RuntimeJobSubmission } from '@/lib/host-api';

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

const PLUGIN_RUNTIME_CAPABILITY_ID = 'plugin.runtime';

async function pluginRuntimeCapabilityExecute<TResult>(
  operationId: string,
  input: Record<string, unknown>,
  pluginId?: string,
): Promise<TResult> {
  return await hostApiFetch<TResult>('/api/capabilities/execute', {
    method: 'POST',
    body: JSON.stringify({
      id: PLUGIN_RUNTIME_CAPABILITY_ID,
      operationId,
      scope: await resolveSingleCapabilityScope(PLUGIN_RUNTIME_CAPABILITY_ID),
      target: { kind: 'plugin', ...(pluginId ? { pluginId } : {}) },
      input,
    }),
  });
}

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
  const submission = await pluginRuntimeCapabilityExecute<RuntimeJobSubmission<PluginRuntimePayload>>(
    'plugins.setEnabled',
    { pluginIds, enabled: true },
    pluginIds[0],
  );
  return await waitForRuntimeJobResult<PluginRuntimePayload>(submission.job.id);
}

export async function ensurePluginEnabled(pluginId: string): Promise<PluginRuntimePayload> {
  const runtime = await getPluginRuntime();
  if (runtime.execution.enabledPluginIds.includes(pluginId)) {
    return runtime;
  }
  return await setEnabledPluginIds([pluginId]);
}
