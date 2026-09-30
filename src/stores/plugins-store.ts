import { create } from 'zustand';
import { hostApiFetch } from '@/lib/host-api';
import { configurePlugin, operatePlugin } from '@/lib/plugins';

export type PluginCatalogItem = {
  id: string;
  name: string;
  version: string;
  kind: 'builtin' | 'third-party';
  platform: 'openclaw' | 'matchaclaw';
  category: string;
  group: 'channel' | 'model' | 'general';
  description?: string;
  enabled: boolean;
  controlMode?: 'manual';
  source?: 'workspace' | 'bundled' | 'openclaw-extension' | 'matchaclaw-extension';
  companionSkillSlugs?: string[];
};

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

type CatalogPayload = {
  success?: boolean;
  execution?: {
    enabledPluginIds: string[];
  };
  plugins: PluginCatalogItem[];
};

export type PluginConfigurationOutcome = 'configured' | 'rejected' | 'unknown';
export type PluginOperation = 'install' | 'update' | 'uninstall';

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
const RUNTIME_HOST_RESTART_TIMEOUT_MS = 130_000;
const RUNTIME_HOST_READY_TIMEOUT_MS = 15_000;
const RUNTIME_HOST_READY_RETRY_MS = 300;
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

function hasMutatingState(action: 'restart' | PluginOperation | null, pluginId: string | null): boolean {
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
  mutatingAction: 'restart' | PluginOperation | null;
  mutatingPluginId: string | null;
  error: string | null;
  prewarm: () => Promise<void>;
  refreshRuntime: (options?: PluginFetchOptions) => Promise<void>;
  refreshCatalog: (options?: PluginFetchOptions) => Promise<void>;
  refreshSnapshot: (options?: PluginRefreshOptions) => Promise<void>;
  restartHost: () => Promise<void>;
  togglePluginEnabled: (pluginId: string, nextEnabled: boolean) => Promise<PluginConfigurationOutcome>;
  operatePlugin: (pluginId: string, operation: PluginOperation) => Promise<PluginConfigurationOutcome>;
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
      const refreshTasks = [get().refreshCatalog({ reason, force: options?.force })];
      if (get().runtimeReady) {
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

  togglePluginEnabled: async (pluginId, nextEnabled) => {
    set({ mutatingPluginId: pluginId, mutating: true, error: null });
    try {
      const outcome = await configurePlugin(pluginId, nextEnabled);
      if (outcome !== 'configured') {
        set({ error: 'plugins:errors.togglePluginFailed' });
      } else {
        await get().refreshCatalog({ reason: 'mutation', force: true });
      }
      return outcome;
    } catch (error) {
      set({ error: 'plugins:errors.togglePluginFailed' });
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

  operatePlugin: async (pluginId, operation) => {
    set({ mutatingPluginId: pluginId, mutatingAction: operation, mutating: true, error: null });
    try {
      const outcome = await operatePlugin(pluginId, operation);
      if (outcome !== 'configured') {
        set({ error: 'plugins:errors.operationFailed' });
      } else {
        await get().refreshCatalog({ reason: 'mutation', force: true });
      }
      return outcome;
    } catch (error) {
      set({ error: 'plugins:errors.operationFailed' });
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
