import { hostApiFetch, hostCapabilityExecute, waitForRuntimeJobResult, type RuntimeJobSubmission } from '@/lib/host-api';
import type { RuntimeAddress } from '../../../runtime-host/shared/runtime-address';

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
  runtimeAddress: RuntimeAddress,
  input: Record<string, unknown>,
): Promise<TResult> {
  return await hostCapabilityExecute<TResult>({
    id: PLUGIN_RUNTIME_CAPABILITY_ID,
    operationId,
    runtimeAddress,
    input: {
      ...input,
      runtimeAddress,
    },
  });
}

export async function getPluginCatalog(): Promise<PluginCatalogPayload> {
  return await hostApiFetch<PluginCatalogPayload>('/api/plugins/catalog');
}

export async function getPluginRuntime(): Promise<PluginRuntimePayload> {
  return await hostApiFetch<PluginRuntimePayload>('/api/plugins/runtime');
}

export async function setEnabledPluginIds(pluginIds: string[], runtimeAddress: RuntimeAddress): Promise<PluginRuntimePayload> {
  const submission = await pluginRuntimeCapabilityExecute<RuntimeJobSubmission<PluginRuntimePayload>>(
    'plugins.setEnabled',
    runtimeAddress,
    { pluginIds },
  );
  return await waitForRuntimeJobResult<PluginRuntimePayload>(submission.job.id);
}

export async function ensurePluginEnabled(pluginId: string, runtimeAddress: RuntimeAddress): Promise<PluginRuntimePayload> {
  const runtime = await getPluginRuntime();
  if (runtime.execution.enabledPluginIds.includes(pluginId)) {
    return runtime;
  }
  return await setEnabledPluginIds([...runtime.execution.enabledPluginIds, pluginId], runtimeAddress);
}
