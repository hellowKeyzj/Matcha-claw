import { TRANSPORT_VERSION } from '../../shared/runtime-host-constants';
import type { RuntimeHostLifecycle } from '../../shared/types';
import type { RuntimeLifecycleState } from '../common/runtime-contracts';
import type { RuntimeHostCatalogPlugin } from '../../bootstrap/runtime-config';
import type { RuntimeClockPort, RuntimeProcessInfoPort } from '../common/runtime-ports';

export function createHealthPayload(
  lifecycle: RuntimeLifecycleState,
  startedAtMs: number,
  processInfo: Pick<RuntimeProcessInfoPort, 'pid'>,
  clock: RuntimeClockPort,
) {
  return {
    version: TRANSPORT_VERSION,
    ok: lifecycle === 'running',
    lifecycle,
    pid: processInfo.pid,
    uptimeSec: Math.floor((clock.nowMs() - startedAtMs) / 1000),
  };
}

export function buildLocalPluginStates(params: {
  lifecycle: RuntimeLifecycleState;
  enabledPluginIds: string[];
  pluginCatalog: RuntimeHostCatalogPlugin[];
}) {
  const isRuntimeRunning = params.lifecycle === 'running';
  const enabledSet = new Set(params.enabledPluginIds);

  return params.pluginCatalog.map((plugin) => ({
    id: plugin.id,
    kind: plugin.kind,
    platform: plugin.platform,
    lifecycle: isRuntimeRunning && enabledSet.has(plugin.id)
      ? 'active'
      : 'inactive',
    version: plugin.version,
    category: plugin.category,
    description: plugin.description,
  }));
}

export function buildLocalRuntimeState(params: {
  lifecycle: RuntimeLifecycleState;
  enabledPluginIds: string[];
  pluginCatalog: RuntimeHostCatalogPlugin[];
}) {
  return {
    lifecycle: params.lifecycle as RuntimeHostLifecycle,
    plugins: buildLocalPluginStates(params),
  };
}

export function buildLocalRuntimeHealth(state: { lifecycle: RuntimeHostLifecycle; plugins: Array<{ lifecycle?: string }> }) {
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

export function buildTransportStatsSnapshot(transportStats: {
  totalDispatchRequests: number;
  runtimeRouteHandled: number;
  unhandledRouteCount: number;
  badRequestRejected: number;
  dispatchInternalError: number;
}) {
  return {
    totalDispatchRequests: transportStats.totalDispatchRequests,
    runtimeRouteHandled: transportStats.runtimeRouteHandled,
    unhandledRouteCount: transportStats.unhandledRouteCount,
    badRequestRejected: transportStats.badRequestRejected,
    dispatchInternalError: transportStats.dispatchInternalError,
  };
}

export function buildLocalPluginsRuntimePayload(params: {
  lifecycle: RuntimeLifecycleState;
  enabledPluginIds: string[];
  pluginCatalog: RuntimeHostCatalogPlugin[];
}) {
  const runtimeState = buildLocalRuntimeState(params);
  const runtimeHealth = buildLocalRuntimeHealth(runtimeState);
  return {
    success: true,
    state: {
      lifecycle: params.lifecycle,
      runtimeLifecycle: params.lifecycle,
      activePluginCount: runtimeHealth.activePluginCount,
      enabledPluginIds: params.enabledPluginIds,
    },
    health: runtimeHealth,
    execution: {
      enabledPluginIds: params.enabledPluginIds,
    },
  };
}

export interface RuntimeHostStatePort {
  health(): unknown;
  transportStats(): unknown;
  runtimeState(): ReturnType<typeof buildLocalRuntimeState>;
}

export class RuntimeHostStateService implements RuntimeHostStatePort {
  constructor(
    private readonly deps: {
      readonly getRuntimeState: () => ReturnType<typeof buildLocalRuntimeState>;
      readonly buildRuntimeHealth: (state: ReturnType<typeof buildLocalRuntimeState>) => unknown;
      readonly buildTransportStats: () => ReturnType<typeof buildTransportStatsSnapshot>;
      readonly clock: RuntimeClockPort;
    },
  ) {}

  runtimeState(): ReturnType<typeof buildLocalRuntimeState> {
    return this.deps.getRuntimeState();
  }

  health() {
    const state = this.runtimeState();
    return {
      success: true,
      state,
      health: this.deps.buildRuntimeHealth(state),
    };
  }

  transportStats() {
    return {
      success: true,
      generatedAt: this.deps.clock.nowMs(),
      stats: this.deps.buildTransportStats(),
    };
  }
}
