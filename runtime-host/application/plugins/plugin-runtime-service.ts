import { accepted, badRequest, ok, type ApplicationResponse } from '../common/application-response';
import { isChannelDerivedPluginId } from '../channels/channel-plugin-bindings';
import type { PluginRuntimeJobPort } from './plugin-runtime-jobs';

export interface PluginRuntimeServiceDeps {
  runtime: PluginRuntimePort;
  jobs: PluginRuntimeJobPort;
}

export interface PluginRuntimePort {
  snapshotPluginsRuntimePayload(): unknown;
  enqueueRefresh(): unknown;
  getRefreshJob(): unknown;
  getEnabledPluginIds(): string[];
  getPluginCatalog(): Array<Record<string, any>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export class PluginRuntimeService {
  constructor(private readonly deps: PluginRuntimeServiceDeps) {}

  runtime(): ApplicationResponse {
    this.deps.runtime.enqueueRefresh();
    return ok({
      ...(this.deps.runtime.snapshotPluginsRuntimePayload() as Record<string, unknown>),
      refreshJob: this.deps.runtime.getRefreshJob(),
    });
  }

  catalog(): ApplicationResponse {
    this.deps.runtime.enqueueRefresh();
    const enabledPluginIds = this.deps.runtime.getEnabledPluginIds();
    const enabledSet = new Set(enabledPluginIds);
    return ok({
      success: true,
      refreshJob: this.deps.runtime.getRefreshJob(),
      execution: {
        enabledPluginIds,
      },
      plugins: this.deps.runtime.getPluginCatalog().map((plugin) => decoratePluginCatalogEntry(
        plugin,
        enabledSet.has(plugin.id),
      )),
    });
  }

  setEnabled(payload: unknown): ApplicationResponse {
    const body = isRecord(payload) ? payload : null;
    const pluginIds = Array.isArray(body?.pluginIds) && body.pluginIds.every((item) => typeof item === 'string')
      ? body.pluginIds as string[]
      : null;
    if (!pluginIds) {
      return badRequest('pluginIds 必须是 string[]');
    }

    return accepted(this.deps.jobs.submitSetEnabledPlugins({ pluginIds }));
  }
}

function decoratePluginCatalogEntry(plugin: Record<string, any>, enabled: boolean): Record<string, any> {
  return {
    ...plugin,
    enabled,
    group: isChannelDerivedPluginId(plugin.id) ? 'channel' : plugin.group,
    controlMode: isChannelDerivedPluginId(plugin.id) ? 'channel-config' : (plugin.controlMode ?? 'manual'),
  };
}
