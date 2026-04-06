import { TRANSPORT_VERSION } from './constants';

export function createHealthPayload(lifecycle: string, startedAtMs: number) {
  return {
    version: TRANSPORT_VERSION,
    ok: lifecycle === 'running',
    lifecycle,
    pid: process.pid,
    uptimeSec: Math.floor((Date.now() - startedAtMs) / 1000),
  };
}

export function toRuntimeLifecycle(lifecycle: string) {
  if (lifecycle === 'starting') {
    return 'booting';
  }
  if (lifecycle === 'running') {
    return 'running';
  }
  if (lifecycle === 'stopped') {
    return 'stopped';
  }
  if (lifecycle === 'error') {
    return 'error';
  }
  return 'idle';
}

export function buildLocalPluginStates(params: {
  lifecycle: string;
  pluginExecutionEnabled: boolean;
  enabledPluginIds: string[];
  pluginCatalog: Array<Record<string, any>>;
}) {
  const runtimeLifecycle = toRuntimeLifecycle(params.lifecycle);
  const isRuntimeRunning = runtimeLifecycle === 'running';
  const enabledSet = new Set(params.enabledPluginIds);

  return params.pluginCatalog.map((plugin) => ({
    id: plugin.id,
    kind: plugin.kind,
    platform: plugin.platform,
    lifecycle: isRuntimeRunning && params.pluginExecutionEnabled && enabledSet.has(plugin.id)
      ? 'active'
      : 'inactive',
    version: plugin.version,
    category: plugin.category,
    description: plugin.description,
  }));
}

export function buildLocalRuntimeState(params: {
  lifecycle: string;
  pluginExecutionEnabled: boolean;
  enabledPluginIds: string[];
  pluginCatalog: Array<Record<string, any>>;
}) {
  return {
    lifecycle: toRuntimeLifecycle(params.lifecycle),
    plugins: buildLocalPluginStates(params),
  };
}

export function buildLocalRuntimeHealth(state: { lifecycle: string; plugins: Array<{ lifecycle?: string }> }) {
  const runtimeLifecycle = state.lifecycle;
  const isRunning = runtimeLifecycle === 'running';
  const activePluginCount = state.plugins.filter((plugin) => plugin.lifecycle === 'active').length;
  return {
    ok: isRunning,
    lifecycle: runtimeLifecycle,
    activePluginCount,
    degradedPlugins: [],
    ...(isRunning ? {} : { error: `runtime-host child is ${runtimeLifecycle}` }),
  };
}

export function buildTransportStatsSnapshot(transportStats: Record<string, number>) {
  return {
    totalDispatchRequests: transportStats.totalDispatchRequests,
    localBusinessHandled: transportStats.localBusinessHandled,
    executionSyncHandled: transportStats.executionSyncHandled,
    executionSyncFailed: transportStats.executionSyncFailed,
    unhandledRouteCount: transportStats.unhandledRouteCount,
    badRequestRejected: transportStats.badRequestRejected,
    dispatchInternalError: transportStats.dispatchInternalError,
  };
}

export function buildLocalPluginsRuntimePayload(params: {
  lifecycle: string;
  pluginExecutionEnabled: boolean;
  enabledPluginIds: string[];
  pluginCatalog: Array<Record<string, any>>;
}) {
  const runtimeState = buildLocalRuntimeState(params);
  const runtimeHealth = buildLocalRuntimeHealth(runtimeState);
  return {
    success: true,
    state: {
      lifecycle: params.lifecycle,
      runtimeLifecycle: toRuntimeLifecycle(params.lifecycle),
      activePluginCount: runtimeHealth.activePluginCount,
      pluginExecutionEnabled: params.pluginExecutionEnabled,
      enabledPluginIds: params.enabledPluginIds,
    },
    health: runtimeHealth,
    execution: {
      pluginExecutionEnabled: params.pluginExecutionEnabled,
      enabledPluginIds: params.enabledPluginIds,
    },
  };
}
