import { create } from 'zustand';
import { hostApiFetch } from '@/lib/host-api';
import { configurePlugin, operatePlugin } from '@/lib/plugins';

import { selectManagementEndpoint, selectManagementAgentScope, useRuntimeEndpointsStore } from '@/stores/runtime-endpoints';
import { buildCapabilityScopeKey, runtimeInstanceScope, runtimeScopeQuery } from '@/types/desktop/runtime-address';
import { isPluginCatalog, isPluginScope, type PluginCatalogItem, type PluginScope } from '@/types/plugins';
export type { PluginCatalogItem } from '@/types/plugins';

type RuntimeLifecycle = 'starting' | 'running' | 'restarting' | 'stopping' | 'stopped' | 'error';

export type RuntimePayload = {
  success: boolean;
  state: {
    lifecycle: RuntimeLifecycle;
    runtimeLifecycle: RuntimeLifecycle;
    activePluginCount: number;
    enabledPluginIds: string[];
    lastError?: string;
  };
  health: {
    ok: boolean;
    lifecycle: RuntimeLifecycle;
    activePluginCount: number;
    degradedPlugins: string[];
    error?: string;
  };
  execution: {
    enabledPluginIds: string[];
  };
};

export type PluginConfigurationOutcome = 'configured' | 'rejected' | 'unknown';
export type PluginOperation = 'install' | 'update' | 'uninstall';

export type PluginRefreshReason = 'initial' | 'manual' | 'mutation' | 'background';

type PluginFetchOptions = {
  force?: boolean;
  reason?: PluginRefreshReason;
};
type CatalogFetchOptions = PluginFetchOptions & { scope?: PluginScope };

type PluginRefreshOptions = PluginFetchOptions & {
  silent?: boolean;
};

const PLUGIN_LOAD_FAILED_KEY = 'plugins:errors.loadFailed';
const PLUGIN_CACHE_FRESH_MS = 30_000;
const RUNTIME_HOST_RESTART_TIMEOUT_MS = 130_000;
const RUNTIME_HOST_READY_TIMEOUT_MS = 15_000;
const RUNTIME_HOST_READY_RETRY_MS = 300;
const EMPTY_CATALOG: PluginCatalogItem[] = [];

let runtimeCache: RuntimePayload | null = null;
let runtimeCacheUpdatedAt = 0;
let catalogCache: { key: string; plugins: PluginCatalogItem[]; updatedAt: number } | null = null;
const OPENCLAW_SCOPE = runtimeInstanceScope({ kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' });
const OPENCLAW_SCOPE_KEY = buildCapabilityScopeKey(OPENCLAW_SCOPE);

function selectedPluginScope(): PluginScope | null {
  const state = useRuntimeEndpointsStore.getState();
  const endpoint = selectManagementEndpoint(state);
  const scope = endpoint?.kind === 'native-runtime' && endpoint.runtimeAdapterId === 'openclaw'
    ? runtimeInstanceScope(endpoint) : selectManagementAgentScope(state);
  return isPluginScope(scope) ? scope : null;
}
let runtimeInflightTask: Promise<RuntimePayload> | null = null;
let runtimeFetchGeneration = 0;
let catalogInflight: { key: string; task: Promise<PluginCatalogItem[]> } | null = null;
let catalogFetchGeneration = 0;
let latestRuntimeRequestId = 0;
let latestCatalogRequestId = 0;
let latestSnapshotRefreshRequestId = 0;

function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function readRuntimeCache(): RuntimePayload | null {
  return runtimeCache ? cloneValue(runtimeCache) : null;
}

function readCatalogCache(key: string): PluginCatalogItem[] {
  return catalogCache?.key === key ? cloneValue(catalogCache.plugins) : cloneValue(EMPTY_CATALOG);
}

function writeRuntimeCache(payload: RuntimePayload): RuntimePayload {
  runtimeCache = cloneValue(payload);
  runtimeCacheUpdatedAt = Date.now();
  return readRuntimeCache() as RuntimePayload;
}

function writeCatalogCache(key: string, plugins: PluginCatalogItem[]): PluginCatalogItem[] {
  catalogCache = { key, plugins: cloneValue(plugins), updatedAt: Date.now() };
  return readCatalogCache(key);
}

function hasFreshRuntimeCache(): boolean {
  return runtimeCache !== null && (Date.now() - runtimeCacheUpdatedAt) < PLUGIN_CACHE_FRESH_MS;
}

function hasFreshCatalogCache(key: string): boolean {
  return catalogCache?.key === key && (Date.now() - catalogCache.updatedAt) < PLUGIN_CACHE_FRESH_MS;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function isRuntimeReady(payload: RuntimePayload): boolean {
  return payload.health.ok
    && payload.state.lifecycle === 'running'
    && payload.state.runtimeLifecycle === 'running'
    && payload.health.lifecycle === 'running';
}

async function fetchRuntimeShared(force: boolean): Promise<RuntimePayload> {
  if (!force && runtimeInflightTask) {
    return await runtimeInflightTask;
  }

  const generation = ++runtimeFetchGeneration;
  const task = (async () => {
    const payload = await hostApiFetch<RuntimePayload>('/api/plugins/runtime');
    if (generation === runtimeFetchGeneration) writeRuntimeCache(payload);
    return payload;
  })();

  runtimeInflightTask = task;
  try {
    return await task;
  } finally {
    if (runtimeInflightTask === task) {
      runtimeInflightTask = null;
    }
  }
}

async function restartRuntimeHost(): Promise<void> {
  const admission = await hostApiFetch<{ accepted: true; restartId: string }>(
    '/api/runtime-host/restart', { method: 'POST' },
  );
  if (admission.accepted !== true || typeof admission.restartId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(admission.restartId)) {
    throw new Error('Invalid Runtime Host restart admission');
  }
  const startedAt = Date.now();
  while (Date.now() - startedAt <= RUNTIME_HOST_RESTART_TIMEOUT_MS) {
    const restart = await hostApiFetch<
      | { restartId: string; status: 'running' }
      | { restartId: string; status: 'succeeded'; result: { status: 'running'; recoveredAt: number } }
      | { restartId: string; status: 'failed' | 'unknown'; error: string }
    >(`/api/runtime-host/restart?restartId=${encodeURIComponent(admission.restartId)}`);
    if (restart.restartId !== admission.restartId) {
      throw new Error('Runtime Host restart identity mismatch');
    }
    if (restart.status === 'succeeded') {
      if (restart.result?.status !== 'running' || !Number.isSafeInteger(restart.result.recoveredAt)) {
        throw new Error('Invalid Runtime Host restart result');
      }
      return;
    }
    if (restart.status === 'failed' || restart.status === 'unknown') {
      throw new Error(restart.error);
    }
    if (restart.status !== 'running') throw new Error('Invalid Runtime Host restart status');
    await delay(RUNTIME_HOST_READY_RETRY_MS);
  }
  throw new Error('Runtime Host restart outcome is unknown; observation timed out');
}

async function waitForRuntimeHostReady(): Promise<RuntimePayload> {
  const startedAt = Date.now();
  let lastError: unknown = null;

  while (Date.now() - startedAt <= RUNTIME_HOST_READY_TIMEOUT_MS) {
    try {
      const payload = await hostApiFetch<RuntimePayload>('/api/plugins/runtime');
      const cached = writeRuntimeCache(payload);
      if (isRuntimeReady(cached)) {
        return cached;
      }
      lastError = new Error(`Runtime Host is ${cached.state.runtimeLifecycle}`);
    } catch (error) {
      lastError = error;
    }
    await delay(RUNTIME_HOST_READY_RETRY_MS);
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Runtime Host did not become ready after restart');
}

async function fetchCatalogShared(scope: PluginScope, force: boolean): Promise<PluginCatalogItem[]> {
  const key = buildCapabilityScopeKey(scope);
  if (!force && catalogInflight?.key === key) return catalogInflight.task;
  const generation = ++catalogFetchGeneration;
  const task = (async () => {
    const payload = await hostApiFetch<unknown>(`/api/plugins/catalog?${runtimeScopeQuery(scope)}`);
    if (!isPluginCatalog(payload, scope)) throw new Error('Invalid plugin catalog');
    const plugins = [...payload.plugins];
    if (generation === catalogFetchGeneration) writeCatalogCache(key, plugins);
    return plugins;
  })();
  catalogInflight = { key, task };
  try { return await task; } finally {
    if (catalogInflight?.task === task) catalogInflight = null;
  }
}

function hasMutatingState(action: 'restart' | PluginOperation | null, pluginId: string | null): boolean {
  return action !== null || pluginId !== null;
}

interface PluginsStoreState {
  runtime: RuntimePayload | null;
  catalog: PluginCatalogItem[];
  catalogScope: PluginScope | null;
  catalogScopeKey: string | null;
  setScope: (scope: PluginScope | null) => void;
  runtimeReady: boolean;
  catalogReady: boolean;
  runtimePending: boolean;
  catalogPending: boolean;
  refreshing: boolean;
  refreshReason: PluginRefreshReason | null;
  mutating: boolean;
  mutatingAction: 'restart' | PluginOperation | null;
  mutatingPluginId: string | null;
  error: string | null;
  prewarm: () => Promise<void>;
  refreshRuntime: (options?: PluginFetchOptions) => Promise<void>;
  refreshCatalog: (options?: CatalogFetchOptions) => Promise<void>;
  refreshSnapshot: (options?: PluginRefreshOptions) => Promise<void>;
  restartHost: () => Promise<void>;
  togglePluginEnabled: (pluginId: string, nextEnabled: boolean, scope?: PluginScope) => Promise<PluginConfigurationOutcome>;
  operatePlugin: (pluginId: string, operation: PluginOperation, scope?: PluginScope) => Promise<PluginConfigurationOutcome>;
  clearError: () => void;
}

export const usePluginsStore = create<PluginsStoreState>((set, get) => ({
  runtime: readRuntimeCache(),
  catalog: [],
  catalogScope: null,
  catalogScopeKey: null,
  setScope: (scope) => {
    if (scope !== null && !isPluginScope(scope)) throw new Error('Invalid plugin scope');
    const key = scope ? buildCapabilityScopeKey(scope) : null;
    if (key === get().catalogScopeKey) return;
    ++latestCatalogRequestId;
    ++latestSnapshotRefreshRequestId;
    set({ catalogScope: scope, catalogScopeKey: key, catalog: key ? readCatalogCache(key) : [],
      catalogReady: key !== null && catalogCache?.key === key, catalogPending: false,
      refreshing: false, refreshReason: null, error: null });
  },
  runtimeReady: runtimeCache !== null,
  catalogReady: false,
  runtimePending: false,
  catalogPending: false,
  refreshing: false,
  refreshReason: null,
  mutating: false,
  mutatingAction: null,
  mutatingPluginId: null,
  error: null,

  prewarm: async () => {
    const scope = selectedPluginScope();
    get().setScope(scope);
    if (!scope) return;
    await Promise.allSettled([
      get().refreshCatalog({ scope, reason: 'background' }),
      ...(scope.kind === 'runtime-instance' ? [get().refreshRuntime({ reason: 'background' })] : []),
    ]);
  },

  refreshRuntime: async (options) => {
    const reason = options?.reason ?? 'background';
    const force = options?.force ?? (reason === 'manual' || reason === 'mutation');
    if (!force && hasFreshRuntimeCache()) {
      return;
    }

    const requestId = ++latestRuntimeRequestId;
    const catalogKey = get().catalogScopeKey;
    set({ runtimePending: true, ...(catalogKey === OPENCLAW_SCOPE_KEY || catalogKey === null ? { error: null } : {}) });

    try {
      const runtime = await fetchRuntimeShared(force);
      if (requestId !== latestRuntimeRequestId) {
        return;
      }
      set({
        runtime,
        runtimeReady: true,
        runtimePending: false,
      });
    } catch (error) {
      if (requestId !== latestRuntimeRequestId) {
        return;
      }
      set({
        runtimePending: false,
        ...(get().catalogScopeKey === catalogKey && (catalogKey === OPENCLAW_SCOPE_KEY || catalogKey === null)
          ? { error: PLUGIN_LOAD_FAILED_KEY } : {}),
      });
      throw error;
    }
  },

  refreshCatalog: async (options) => {
    const reason = options?.reason ?? 'background';
    const force = options?.force ?? (reason === 'manual' || reason === 'mutation');
    const scope = options?.scope ?? get().catalogScope;
    if (!scope || !isPluginScope(scope)) return;
    const key = buildCapabilityScopeKey(scope);
    const active = key === get().catalogScopeKey;
    if (!force && hasFreshCatalogCache(key)) {
      if (active) set({ catalog: readCatalogCache(key), catalogReady: true, catalogPending: false });
      return;
    }
    const requestId = active ? ++latestCatalogRequestId : null;
    if (active) set({ catalogPending: true, error: null });

    try {
      const catalog = await fetchCatalogShared(scope, force);
      if (requestId !== latestCatalogRequestId || key !== get().catalogScopeKey) {
        return;
      }
      set({
        catalog,
        catalogReady: true,
        catalogPending: false,
      });
    } catch (error) {
      if (requestId !== latestCatalogRequestId || key !== get().catalogScopeKey) {
        return;
      }
      set({
        catalogPending: false,
        error: PLUGIN_LOAD_FAILED_KEY,
      });
      throw error;
    }
  },

  refreshSnapshot: async (options) => {
    const reason = options?.reason ?? 'background';
    const hasCachedData = get().runtimeReady || get().catalogReady;
    const silent = options?.silent ?? ((reason === 'initial' || reason === 'background') && hasCachedData);
    const requestId = ++latestSnapshotRefreshRequestId;

    if (!silent) {
      set({
        refreshing: true,
        refreshReason: reason,
        error: null,
      });
    }

    try {
      const refreshTasks = [get().refreshCatalog({ reason, force: options?.force })];
      if (get().catalogScopeKey === OPENCLAW_SCOPE_KEY) {
        refreshTasks.push(get().refreshRuntime({ reason, force: options?.force }));
      }
      await Promise.all(refreshTasks);
      if (requestId !== latestSnapshotRefreshRequestId || silent) {
        return;
      }
      set({
        refreshing: false,
        refreshReason: null,
      });
    } catch (error) {
      if (requestId !== latestSnapshotRefreshRequestId || silent) {
        return;
      }
      set({
        refreshing: false,
        refreshReason: null,
        error: PLUGIN_LOAD_FAILED_KEY,
      });
      throw error;
    } finally {
      if (requestId === latestSnapshotRefreshRequestId && !silent) {
        set((state) => ({
          ...state,
          refreshing: false,
          refreshReason: null,
        }));
      }
    }
  },

  restartHost: async () => {
    set({ mutatingAction: 'restart', mutating: true, error: null });
    try {
      await restartRuntimeHost();
      const payload = await waitForRuntimeHostReady();
      set({
        runtime: payload,
        runtimeReady: true,
      });
      await get().refreshSnapshot({ reason: 'mutation', force: true, silent: true });
    } finally {
      set((state) => {
        const nextAction = state.mutatingAction === 'restart' ? null : state.mutatingAction;
        return {
          mutatingAction: nextAction,
          mutating: hasMutatingState(nextAction, state.mutatingPluginId),
        };
      });
    }
  },

  togglePluginEnabled: async (pluginId, nextEnabled, requestedScope) => {
    const scope = cloneValue(requestedScope ?? get().catalogScope);
    if (!scope || !isPluginScope(scope) || get().mutating) throw new Error('Plugin mutation is unavailable');
    const key = buildCapabilityScopeKey(scope);
    set({ mutatingPluginId: pluginId, mutating: true, error: null });
    try {
      const outcome = await configurePlugin(pluginId, nextEnabled, scope);
      if (outcome !== 'configured') {
        if (get().catalogScopeKey === key) set({ error: 'plugins:errors.togglePluginFailed' });
      } else {
        await get().refreshCatalog({ scope, reason: 'mutation', force: true });
        if (key === OPENCLAW_SCOPE_KEY) await get().refreshRuntime({ reason: 'mutation', force: true });
      }
      return outcome;
    } catch (error) {
      if (get().catalogScopeKey === key) set({ error: 'plugins:errors.togglePluginFailed' });
      throw error;
    } finally {
      set((state) => {
        const nextPluginId = state.mutatingPluginId === pluginId ? null : state.mutatingPluginId;
        return {
          mutatingPluginId: nextPluginId,
          mutating: hasMutatingState(state.mutatingAction, nextPluginId),
        };
      });
    }
  },

  operatePlugin: async (pluginId, operation, requestedScope) => {
    const scope = cloneValue(requestedScope ?? get().catalogScope);
    if (!scope || !isPluginScope(scope) || get().mutating) throw new Error('Plugin mutation is unavailable');
    const key = buildCapabilityScopeKey(scope);
    set({ mutatingPluginId: pluginId, mutatingAction: operation, mutating: true, error: null });
    try {
      const outcome = await operatePlugin(pluginId, operation, scope);
      if (outcome !== 'configured') {
        if (get().catalogScopeKey === key) set({ error: 'plugins:errors.operationFailed' });
      } else {
        await get().refreshCatalog({ scope, reason: 'mutation', force: true });
        if (key === OPENCLAW_SCOPE_KEY) await get().refreshRuntime({ reason: 'mutation', force: true });
      }
      return outcome;
    } catch (error) {
      if (get().catalogScopeKey === key) set({ error: 'plugins:errors.operationFailed' });
      throw error;
    } finally {
      set((state) => {
        const nextPluginId = state.mutatingPluginId === pluginId ? null : state.mutatingPluginId;
        return {
          mutatingPluginId: nextPluginId,
          mutatingAction: null,
          mutating: hasMutatingState(null, nextPluginId),
        };
      });
    }
  },

  clearError: () => set((state) => (
    state.error === null
      ? state
      : { ...state, error: null }
  )),
}));

export async function prewarmPluginsData(): Promise<void> {
  await usePluginsStore.getState().prewarm();
}
