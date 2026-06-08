import { accepted, badRequest, ok, type ApplicationResponse } from '../../common/application-response';
import type {
  PluginRuntimePort,
  RuntimePluginCatalogProjectionPort,
} from '../../plugins/runtime-plugin-service';
import type { PluginRuntimeJobPort } from '../../plugins/plugin-runtime-jobs';

export interface PluginRuntimeOperationsWorkflowDeps {
  readonly runtime: PluginRuntimePort;
  readonly jobs: PluginRuntimeJobPort;
  readonly catalogProjection: RuntimePluginCatalogProjectionPort;
}

export class PluginRuntimeOperationsWorkflow {
  constructor(private readonly deps: PluginRuntimeOperationsWorkflowDeps) {}

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
      plugins: this.deps.runtime.getPluginCatalog().map((plugin) => this.decoratePluginCatalogEntry(
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

    const enabled = body?.enabled !== false;
    return accepted(this.deps.jobs.submitSetEnabledPlugins({ pluginIds, enabled }));
  }

  private decoratePluginCatalogEntry(plugin: Record<string, any>, enabled: boolean): Record<string, any> {
    const channelDerived = this.deps.catalogProjection.isChannelDerivedPluginId(plugin.id);
    return {
      ...plugin,
      enabled,
      group: channelDerived ? 'channel' : plugin.group,
      controlMode: channelDerived ? 'channel-config' : (plugin.controlMode ?? 'manual'),
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
