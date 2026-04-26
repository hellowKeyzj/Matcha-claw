import { isChannelDerivedPluginId } from '../../application/channels/channel-plugin-bindings';

interface LocalDispatchResponse {
  status: number;
  data: unknown;
}

interface PluginRuntimeRouteDeps {
  buildLocalPluginsRuntimePayload: () => unknown;
  refreshPluginCatalog: () => Promise<void>;
  setEnabledPluginIds: (pluginIds: string[]) => Promise<string[]>;
  requestParentShellAction: (action: 'gateway_restart', payload?: unknown) => Promise<{
    success: boolean;
    status: number;
    data?: unknown;
    error?: { code: string; message: string };
  }>;
  enabledPluginIds: string[];
  getPluginCatalog: () => Array<Record<string, any>>;
}

export async function handlePluginRuntimeRoute(
  method: string,
  routePath: string,
  payload: unknown,
  deps: PluginRuntimeRouteDeps,
): Promise<LocalDispatchResponse | null> {
  const asRecord = (value: unknown): Record<string, unknown> | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  };

  if (method === 'GET' && routePath === '/api/plugins/runtime') {
    await deps.refreshPluginCatalog();
    return {
      status: 200,
      data: deps.buildLocalPluginsRuntimePayload(),
    };
  }

  if (method === 'GET' && routePath === '/api/plugins/catalog') {
    await deps.refreshPluginCatalog();
    const enabledSet = new Set(deps.enabledPluginIds);
    return {
      status: 200,
      data: {
        success: true,
        execution: {
          enabledPluginIds: deps.enabledPluginIds,
        },
        plugins: deps.getPluginCatalog().map((plugin) => ({
          ...plugin,
          enabled: enabledSet.has(plugin.id),
          group: isChannelDerivedPluginId(plugin.id) ? 'channel' : plugin.group,
          controlMode: isChannelDerivedPluginId(plugin.id) ? 'channel-config' : (plugin.controlMode ?? 'manual'),
        })),
      },
    };
  }

  if (method === 'PUT' && routePath === '/api/plugins/runtime/enabled-plugins') {
    const body = asRecord(payload);
    const pluginIds = Array.isArray(body?.pluginIds) && body.pluginIds.every((item) => typeof item === 'string')
      ? body.pluginIds as string[]
      : null;
    if (!pluginIds) {
      return {
        status: 400,
        data: { success: false, error: 'pluginIds 必须是 string[]' },
      };
    }
    await deps.setEnabledPluginIds(pluginIds);
    const restartResponse = await deps.requestParentShellAction('gateway_restart');
    if (!restartResponse.success) {
      return {
        status: restartResponse.status,
        data: { success: false, error: restartResponse.error?.message ?? 'gateway restart failed' },
      };
    }
    await deps.refreshPluginCatalog();
    return {
      status: 200,
      data: deps.buildLocalPluginsRuntimePayload(),
    };
  }

  return null;
}
