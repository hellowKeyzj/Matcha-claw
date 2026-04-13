import { create } from 'zustand';
import { hostApiFetch } from '@/lib/host-api';

export type PluginCatalogItem = {
  id: string;
  name: string;
  version: string;
  kind: 'builtin' | 'third-party';
  platform: 'openclaw' | 'matchaclaw';
  category: string;
  description?: string;
  enabled: boolean;
};

export type RuntimePayload = {
  success: boolean;
  state: {
    lifecycle: 'idle' | 'starting' | 'running' | 'stopped' | 'error';
    runtimeLifecycle: 'idle' | 'booting' | 'ready' | 'degraded' | 'stopped';
    activePluginCount: number;
    pluginExecutionEnabled: boolean;
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
    pluginExecutionEnabled: boolean;
    enabledPluginIds: string[];
  };
};

type CatalogPayload = {
  success: boolean;
  execution: {
    pluginExecutionEnabled: boolean;
    enabledPluginIds: string[];
  };
  plugins: PluginCatalogItem[];
};

export type PluginSnapshot = {
  runtime: RuntimePayload | null;
  plugins: PluginCatalogItem[];
};

export type PluginRefreshReason = 'initial' | 'manual' | 'mutation' | 'background';

const PLUGIN_LOAD_FAILED_KEY = 'plugins:errors.loadFailed';

const EMPTY_PLUGIN_SNAPSHOT: PluginSnapshot = {
  runtime: null,
  plugins: [],
};

let pluginSnapshotCache: PluginSnapshot | null = null;
let pluginSnapshotInflightTask: Promise<PluginSnapshot> | null = null;
let latestPluginRefreshRequestId = 0;

function clonePluginSnapshot(snapshot: PluginSnapshot): PluginSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as PluginSnapshot;
}

function writePluginSnapshotCache(snapshot: PluginSnapshot): PluginSnapshot {
  const cloned = clonePluginSnapshot(snapshot);
  pluginSnapshotCache = cloned;
  return cloned;
}

async function fetchPluginSnapshotShared(): Promise<PluginSnapshot> {
  if (pluginSnapshotInflightTask) {
    return await pluginSnapshotInflightTask;
  }

  const task = (async () => {
    const [runtimePayload, catalogPayload] = await Promise.all([
      hostApiFetch<RuntimePayload>('/api/plugins/runtime'),
      hostApiFetch<CatalogPayload>('/api/plugins/catalog'),
    ]);

    const snapshot: PluginSnapshot = {
      runtime: runtimePayload,
      plugins: Array.isArray(catalogPayload.plugins) ? catalogPayload.plugins : [],
    };
    return writePluginSnapshotCache(snapshot);
  })();

  pluginSnapshotInflightTask = task;
  try {
    return await task;
  } finally {
    if (pluginSnapshotInflightTask === task) {
      pluginSnapshotInflightTask = null;
    }
  }
}

function hasMutatingState(action: 'execution' | 'restart' | null, pluginId: string | null): boolean {
  return action !== null || pluginId !== null;
}

interface PluginsStoreState {
  pluginSnapshot: PluginSnapshot;
  snapshotReady: boolean;
  initialLoading: boolean;
  refreshing: boolean;
  refreshReason: PluginRefreshReason | null;
  mutating: boolean;
  mutatingAction: 'execution' | 'restart' | null;
  mutatingPluginId: string | null;
  error: string | null;
  refreshSnapshot: (options?: { reason?: PluginRefreshReason }) => Promise<void>;
  restartHost: () => Promise<void>;
  toggleExecution: (nextValue: boolean) => Promise<void>;
  togglePluginEnabled: (pluginId: string, nextEnabled: boolean) => Promise<void>;
  clearError: () => void;
}

export const usePluginsStore = create<PluginsStoreState>((set, get) => ({
  pluginSnapshot: pluginSnapshotCache
    ? clonePluginSnapshot(pluginSnapshotCache)
    : clonePluginSnapshot(EMPTY_PLUGIN_SNAPSHOT),
  snapshotReady: pluginSnapshotCache !== null,
  initialLoading: pluginSnapshotCache === null,
  refreshing: false,
  refreshReason: null,
  mutating: false,
  mutatingAction: null,
  mutatingPluginId: null,
  error: null,

  refreshSnapshot: async (options) => {
    const reason = options?.reason ?? 'background';
    const requestId = ++latestPluginRefreshRequestId;
    const hasSnapshot = get().snapshotReady;
    if (hasSnapshot) {
      set({
        refreshing: true,
        refreshReason: reason,
        initialLoading: false,
        error: null,
      });
    } else {
      set({
        initialLoading: true,
        refreshing: false,
        refreshReason: reason,
        error: null,
      });
    }

    try {
      const snapshot = await fetchPluginSnapshotShared();
      if (requestId !== latestPluginRefreshRequestId) {
        return;
      }
      set({
        pluginSnapshot: snapshot,
        snapshotReady: true,
        initialLoading: false,
        refreshing: false,
        refreshReason: null,
        error: null,
      });
    } catch (error) {
      if (requestId !== latestPluginRefreshRequestId) {
        return;
      }
      set({
        initialLoading: false,
        refreshing: false,
        refreshReason: null,
        error: PLUGIN_LOAD_FAILED_KEY,
      });
      throw error;
    }
  },

  restartHost: async () => {
    set({ mutatingAction: 'restart', mutating: true, error: null });
    try {
      const payload = await hostApiFetch<RuntimePayload>('/api/plugins/runtime/restart', { method: 'POST' });
      set((state) => {
        const nextSnapshot: PluginSnapshot = {
          ...state.pluginSnapshot,
          runtime: payload,
        };
        return {
          pluginSnapshot: writePluginSnapshotCache(nextSnapshot),
          snapshotReady: true,
        };
      });
      await get().refreshSnapshot({ reason: 'mutation' });
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

  toggleExecution: async (nextValue) => {
    set({ mutatingAction: 'execution', mutating: true, error: null });
    try {
      const payload = await hostApiFetch<RuntimePayload>('/api/plugins/runtime/execution', {
        method: 'PUT',
        body: JSON.stringify({ enabled: nextValue }),
      });
      set((state) => {
        const nextSnapshot: PluginSnapshot = {
          ...state.pluginSnapshot,
          runtime: payload,
        };
        return {
          pluginSnapshot: writePluginSnapshotCache(nextSnapshot),
          snapshotReady: true,
        };
      });
      await get().refreshSnapshot({ reason: 'mutation' });
    } finally {
      set((state) => {
        const nextAction = state.mutatingAction === 'execution' ? null : state.mutatingAction;
        return {
          mutatingAction: nextAction,
          mutating: hasMutatingState(nextAction, state.mutatingPluginId),
        };
      });
    }
  },

  togglePluginEnabled: async (pluginId, nextEnabled) => {
    const runtime = get().pluginSnapshot.runtime;
    if (!runtime) {
      return;
    }
    const enabledPluginIds = runtime.execution.enabledPluginIds ?? [];
    const nextIds = nextEnabled
      ? Array.from(new Set([...enabledPluginIds, pluginId]))
      : enabledPluginIds.filter((id) => id !== pluginId);
    set({ mutatingPluginId: pluginId, mutating: true, error: null });
    try {
      const payload = await hostApiFetch<RuntimePayload>('/api/plugins/runtime/enabled-plugins', {
        method: 'PUT',
        body: JSON.stringify({ pluginIds: nextIds }),
      });
      set((state) => {
        const nextSnapshot: PluginSnapshot = {
          ...state.pluginSnapshot,
          runtime: payload,
        };
        return {
          pluginSnapshot: writePluginSnapshotCache(nextSnapshot),
          snapshotReady: true,
        };
      });
      await get().refreshSnapshot({ reason: 'mutation' });
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
