interface LocalDispatchResponse {
  status: number;
  data: unknown;
}

interface PluginRuntimeRouteDeps {
  buildLocalPluginsRuntimePayload: () => unknown;
  refreshPluginCatalog: () => Promise<void>;
  pluginExecutionEnabled: boolean;
  enabledPluginIds: string[];
  getPluginCatalog: () => Array<Record<string, any>>;
}

export async function handlePluginRuntimeRoute(
  method: string,
  routePath: string,
  deps: PluginRuntimeRouteDeps,
): Promise<LocalDispatchResponse | null> {
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
          pluginExecutionEnabled: deps.pluginExecutionEnabled,
          enabledPluginIds: deps.enabledPluginIds,
        },
        plugins: deps.getPluginCatalog().map((plugin) => ({
          ...plugin,
          enabled: enabledSet.has(plugin.id),
        })),
      },
    };
  }

  return null;
}
