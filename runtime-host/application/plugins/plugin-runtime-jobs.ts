import type {
  RuntimeLongTaskLookupPort,
  RuntimeLongTaskSubmission,
  RuntimeLongTaskSubmissionPort,
} from '../runtime-host/runtime-task-ports';
import type { RuntimeJobSnapshot } from '../common/runtime-contracts';
import { RUNTIME_REFRESH_JOB_COOLDOWN_MS } from '../common/runtime-job-throttle';

export const SET_ENABLED_PLUGINS_JOB = 'plugins.setEnabled';
export const REFRESH_PLUGIN_CATALOG_JOB = 'plugins.refreshCatalog';

export interface SetEnabledPluginsJobPayload {
  readonly pluginIds: readonly string[];
  readonly enabled?: boolean;
}

export type PluginRuntimeJobSubmission = RuntimeLongTaskSubmission;

function buildSetEnabledPluginsDedupeKey(payload: SetEnabledPluginsJobPayload): string {
  const enabled = payload.enabled === false ? 'disable' : 'enable';
  const pluginIds = Array.from(new Set(payload.pluginIds)).sort().join(',');
  return `${SET_ENABLED_PLUGINS_JOB}:${enabled}:${pluginIds}`;
}

export interface PluginRuntimeJobPort {
  submitSetEnabledPlugins(
    payload: SetEnabledPluginsJobPayload,
  ): PluginRuntimeJobSubmission;
  submitRefreshCatalog(): PluginRuntimeJobSubmission;
  getRefreshCatalogJob(): RuntimeJobSnapshot | null;
}

export function createPluginRuntimeJobPort(
  tasks: RuntimeLongTaskSubmissionPort,
  lookup: RuntimeLongTaskLookupPort,
): PluginRuntimeJobPort {
  return {
    submitSetEnabledPlugins: (payload) => tasks.submit(SET_ENABLED_PLUGINS_JOB, payload, {
      dedupeKey: buildSetEnabledPluginsDedupeKey(payload),
    }),
    submitRefreshCatalog: () => tasks.submit(REFRESH_PLUGIN_CATALOG_JOB, null, {
      queue: 'low',
      dedupeKey: REFRESH_PLUGIN_CATALOG_JOB,
      dedupeCooldownMs: RUNTIME_REFRESH_JOB_COOLDOWN_MS,
    }),
    getRefreshCatalogJob: () => lookup.latestByType(REFRESH_PLUGIN_CATALOG_JOB),
  };
}
