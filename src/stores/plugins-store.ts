import { create } from 'zustand';
import { hostApiFetch } from '@/lib/host-api';
import type { PluginGroupId } from '@/features/plugins/plugin-groups';

export type PluginCatalogItem = {
  id: string;
  name: string;
  version: string;
  kind: 'builtin' | 'third-party';
  platform: 'openclaw' | 'matchaclaw';
  category: string;
  group: PluginGroupId;
  description?: string;
  enabled: boolean;
  controlMode?: 'manual' | 'channel-config';
};

export type RuntimePayload = {
  success: boolean;
  state: {
    lifecycle: 'idle' | 'starting' | 'running' | 'stopped' | 'error';
    runtimeLifecycle: 'idle' | 'booting' | 'ready' | 'degraded' | 'stopped';
    activePluginCount: number;
    enabledPluginIds: string[];
    lastError?: string;
  };
  health: {
    ok: boolean;
    lifecycle: 'idle' | 'booting' | 'ready' | 'degraded' | 'stopped';
    activePluginCount: number;
    degradedPlugins: string[];
    error?: string;
  };
  execution: {
    enabledPluginIds: string[];
  };
};

type CatalogPayload = {
  success: boolean;
  execution: {
    enabledPluginIds: string[];
  };
  plugins: PluginCatalogItem[];
};

export type PluginRefreshReason = 'initial' | 'manual' | 'mutation' | 'background';

type PluginFetchOptions = {
  force?: boolean;
  reason?: PluginRefreshReason;
};

type PluginRefreshOptions = PluginFetchOptions & {
  silent?: boolean;
};

const PLUGIN_LOAD_FAILED_KEY = 'plugins:errors.loadFailed';
const PLUGIN_CACHE_FRESH_MS = 30_000;
const EMPTY_CATALOG: PluginCatalogItem[] = [];

let runtimeCache: RuntimePayload | null = null;
let runtimeCacheUpdatedAt = 0;
let catalogCache: PluginCatalogItem[] | null = null;
let catalogCacheUpdatedAt = 0;
let runtimeInflightTask: Promise<RuntimePayload> | null = null;
let catalogInflightTask: Promise<PluginCatalogItem[]> | null = null;
let latestRuntimeRequestId = 0;
let latestCatalogRequestId = 0;
let latestSnapshotRefreshRequestId = 0;

function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function readRuntimeCache(): RuntimePayload | null {
  return runtimeCache ? cloneValue(runtimeCache) : null;
}

function readCatalogCache(): PluginCatalogItem[] {
  return catalogCache ? cloneValue(catalogCache) : cloneValue(EMPTY_CATALOG);
}

function writeRuntimeCache(payload: RuntimePayload): RuntimePayload {
  runtimeCache = cloneValue(payload);
  runtimeCacheUpdatedAt = Date.now();
  return readRuntimeCache() as RuntimePayload;
}

function writeCatalogCache(plugins: PluginCatalogItem[]): PluginCatalogItem[] {
  catalogCache = cloneValue(Array.isArray(plugins) ? plugins : EMPTY_CATALOG);
  catalogCacheUpdatedAt = Date.now();
  return readCatalogCache();
}

function hasFreshRuntimeCache(): boolean {
  return runtimeCache !== null && (Date.now() - runtimeCacheUpdatedAt) < PLUGIN_CACHE_FRESH_MS;
}

function hasFreshCatalogCache(): boolean {
  return catalogCache !== null && (Date.now() - catalogCacheUpdatedAt) < PLUGIN_CACHE_FRESH_MS;
}

async function fetchRuntimeShared(): Promise<RuntimePayload> {
  if (runtimeInflightTask) {
    return await runtimeInflightTask;
  }

  const task = (async () => {
    const payload = await hostApiFetch<RuntimePayload>('/api/plugins/runtime');
    return writeRuntimeCache(payload);
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

async function fetchCatalogShared(): Promise<PluginCatalogItem[]> {
  if (catalogInflightTask) {
    return await catalogInflightTask;
  }

  const task = (async () => {
    const payload = await hostApiFetch<CatalogPayload>('/api/plugins/catalog');
    return writeCatalogCache(Array.isArray(payload.plugins) ? payload.plugins : EMPTY_CATALOG);
  })();

  catalogInflightTask = task;
  try {
    return await task;
  } finally {
    if (catalogInflightTask === task) {
      catalogInflightTask = null;
    }
  }
}

function hasMutatingState(action: 'restart' | null, pluginId: string | null): boolean {
  return action !== null || pluginId !== null;
}

interface PluginsStoreState {
  runtime: RuntimePayload | null;
  catalog: PluginCatalogItem[];
  runtimeReady: boolean;
  catalogReady: boolean;
  runtimePending: boolean;
  catalogPending: boolean;
  refreshing: boolean;
  refreshReason: PluginRefreshReason | null;
  mutating: boolean;
  mutatingAction: 'restart' | null;
  mutatingPluginId: string | null;
  error: string | null;
  prewarm: () => Promise<void>;
  refreshRuntime: (options?: PluginFetchOptions) => Promise<void>;
  refreshCatalog: (options?: PluginFetchOptions) => Promise<void>;
  refreshSnapshot: (options?: PluginRefreshOptions) => Promise<void>;
  restartHost: () => Promise<void>;
  togglePluginEnabled: (pluginId: string, nextEnabled: boolean) => Promise<void>;
  clearError: () => void;
}

export const usePluginsStore = create<PluginsStoreState>((set, get) => ({
  runtime: readRuntimeCache(),
  catalog: readCatalogCache(),
  runtimeReady: runtimeCache !== null,
  catalogReady: catalogCache !== null,
  runtimePending: false,
  catalogPending: false,
  refreshing: false,
  refreshReason: null,
  mutating: false,
  mutatingAction: null,
  mutatingPluginId: null,
  error: null,

  prewarm: async () => {
    await Promise.allSettled([
      get().refreshRuntime({ reason: 'background' }),
      get().refreshCatalog({ reason: 'background' }),
    ]);
  },

  refreshRuntime: async (options) => {
    const reason = options?.reason ?? 'background';
    const force = options?.force ?? (reason === 'manual' || reason === 'mutation');
    if (!force && hasFreshRuntimeCache()) {
      return;
    }

    const requestId = ++latestRuntimeRequestId;
    set({ runtimePending: true, error: null });

    try {
      const runtime = await fetchRuntimeShared();
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
        error: PLUGIN_LOAD_FAILED_KEY,
      });
      throw error;
    }
  },

  refreshCatalog: async (options) => {
    const reason = options?.reason ?? 'background';
    const force = options?.force ?? (reason === 'manual' || reason === 'mutation');
    if (!force && hasFreshCatalogCache()) {
      return;
    }

    const requestId = ++latestCatalogRequestId;
    set({ catalogPending: true, error: null });

    try {
      const catalog = await fetchCatalogShared();
      if (requestId !== latestCatalogRequestId) {
        return;
      }
      set({
        catalog,
        catalogReady: true,
        catalogPending: false,
      });
    } catch (error) {
      if (requestId !== latestCatalogRequestId) {
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
      await Promise.all([
        get().refreshRuntime({ reason, force: options?.force }),
        get().refreshCatalog({ reason, force: options?.force }),
      ]);
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
      const payload = await hostApiFetch<RuntimePayload>('/api/plugins/runtime/restart', { method: 'POST' });
      set({
        runtime: writeRuntimeCache(payload),
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

  togglePluginEnabled: async (pluginId, nextEnabled) => {
    const runtime = get().runtime;
    if (!runtime) {
      return;
    }
    const catalog = get().catalog;
    const targetPlugin = catalog.find((plugin) => plugin.id === pluginId);
    if (targetPlugin?.controlMode === 'channel-config') {
      return;
    }
    const enabledPluginIds = runtime.execution.enabledPluginIds ?? [];
    const manuallyManagedEnabledPluginIds = enabledPluginIds.filter((enabledPluginId) => {
      const plugin = catalog.find((item) => item.id === enabledPluginId);
      return plugin?.controlMode !== 'channel-config';
    });
    const nextIds = nextEnabled
      ? Array.from(new Set([...manuallyManagedEnabledPluginIds, pluginId]))
      : manuallyManagedEnabledPluginIds.filter((id) => id !== pluginId);
    set({ mutatingPluginId: pluginId, mutating: true, error: null });
    try {
      const payload = await hostApiFetch<RuntimePayload>('/api/plugins/runtime/enabled-plugins', {
        method: 'PUT',
        body: JSON.stringify({ pluginIds: nextIds }),
      });
      set({
        runtime: writeRuntimeCache(payload),
        runtimeReady: true,
      });
      await get().refreshSnapshot({ reason: 'mutation', force: true, silent: true });
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

  clearError: () => set((state) => (
    state.error === null
      ? state
      : { ...state, error: null }
  )),
}));

export async function prewarmPluginsData(): Promise<void> {
  await usePluginsStore.getState().prewarm();
}
