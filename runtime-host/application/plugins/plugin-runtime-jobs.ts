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
}

export type PluginRuntimeJobSubmission = RuntimeLongTaskSubmission;

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
      dedupeKey: SET_ENABLED_PLUGINS_JOB,
    }),
    submitRefreshCatalog: () => tasks.submit(REFRESH_PLUGIN_CATALOG_JOB, null, {
      queue: 'low',
      dedupeKey: REFRESH_PLUGIN_CATALOG_JOB,
      dedupeCooldownMs: RUNTIME_REFRESH_JOB_COOLDOWN_MS,
    }),
    getRefreshCatalogJob: () => lookup.latestByType(REFRESH_PLUGIN_CATALOG_JOB),
  };
}
