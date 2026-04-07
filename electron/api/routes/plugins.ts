import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PluginApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';
import { normalizePluginIds } from '../../main/runtime-host-contract';
import {
  applyEnabledPluginIdsToOpenClawConfig,
  readEnabledPluginIdsFromOpenClawConfig,
} from '../../../runtime-host/application/openclaw/openclaw-plugin-config-service';

type PluginCatalogResponse = {
  success: boolean;
  execution: {
    pluginExecutionEnabled: boolean;
    enabledPluginIds: readonly string[];
  };
  plugins: Array<Record<string, unknown> & { enabled: boolean }>;
};

type LocalPluginCatalogItem = {
  id: string;
  name: string;
  version: string;
  kind: 'builtin' | 'third-party';
  platform: 'openclaw' | 'matchaclaw';
  category: string;
  description?: string;
};

type PlatformToolRecord = {
  id: string;
  toolIds: string[];
  enabled: boolean;
  name?: string;
  version?: string;
  description?: string;
};

type GatewayRpcEnvelope<T> = {
  success?: boolean;
  result?: T;
  error?: string;
};

type ConfigGetResult = {
  baseHash?: string;
  hash?: string;
  config?: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  if (!value.every((item) => typeof item === 'string')) {
    return null;
  }
  return value;
}

function normalizePlatformToolRecords(payload: unknown): Map<string, PlatformToolRecord> {
  const map = new Map<string, PlatformToolRecord>();
  if (!Array.isArray(payload)) {
    return map;
  }

  for (const entry of payload) {
    if (!isRecord(entry) || typeof entry.id !== 'string') {
      continue;
    }
    const metadata = isRecord(entry.metadata) ? entry.metadata : {};
    const pluginId = typeof metadata.pluginId === 'string'
      ? metadata.pluginId.trim()
      : (typeof entry.source === 'string' && entry.source.startsWith('plugin')
        ? entry.id.trim()
        : '');
    if (!pluginId) {
      continue;
    }
    const existing = map.get(pluginId);
    const toolId = entry.id.trim();
    map.set(pluginId, {
      id: pluginId,
      toolIds: existing ? Array.from(new Set([...existing.toolIds, toolId])) : [toolId],
      enabled: existing ? (existing.enabled || entry.enabled !== false) : entry.enabled !== false,
      name: existing?.name ?? (typeof entry.name === 'string' ? entry.name : undefined),
      version: existing?.version ?? (typeof entry.version === 'string' ? entry.version : undefined),
      description: existing?.description ?? (typeof entry.description === 'string' ? entry.description : undefined),
    });
  }

  return map;
}

async function loadPluginSnapshots(ctx: PluginApiContext): Promise<{
  localExecutionEnabled: boolean;
  localEnabledPluginIds: string[];
  localCatalog: LocalPluginCatalogItem[];
  openClawToolMap: Map<string, PlatformToolRecord>;
  openClawConfiguredEnabledPluginIds: string[];
}> {
  const execution = await ctx.runtimeHost.refreshExecutionState();
  let localCatalog: LocalPluginCatalogItem[] = [];
  try {
    localCatalog = await ctx.runtimeHost.listAvailablePlugins() as LocalPluginCatalogItem[];
  } catch {
    localCatalog = [];
  }
  let openClawToolMap = new Map<string, PlatformToolRecord>();
  try {
    const result = await ctx.runtimeHost.request<{
      success?: boolean;
      tools?: unknown;
    }>('GET', '/api/platform/tools?includeDisabled=true');
    openClawToolMap = normalizePlatformToolRecords(result.data?.tools);
  } catch {
    openClawToolMap = new Map<string, PlatformToolRecord>();
  }

  return {
    localExecutionEnabled: execution.pluginExecutionEnabled,
    localEnabledPluginIds: execution.enabledPluginIds.filter((pluginId) => (
      localCatalog.some((plugin) => plugin.platform === 'matchaclaw' && plugin.id === pluginId)
    )),
    localCatalog,
    openClawToolMap,
    openClawConfiguredEnabledPluginIds: readEnabledPluginIdsFromOpenClawConfig(),
  };
}

async function buildRuntimePayload(ctx: PluginApiContext) {
  const snapshots = await loadPluginSnapshots(ctx);
  const health = await ctx.runtimeHost.checkHealth();
  const state = ctx.runtimeHost.getState();
  const openClawEnabledPluginIds = snapshots.openClawConfiguredEnabledPluginIds.filter((pluginId) => (
    snapshots.localCatalog.some((plugin) => plugin.platform === 'openclaw' && plugin.id === pluginId)
      || snapshots.openClawToolMap.has(pluginId)
  ));
  const enabledPluginIds = normalizePluginIds([
    ...snapshots.localEnabledPluginIds,
    ...openClawEnabledPluginIds,
  ]);
  return {
    success: true,
    state: {
      lifecycle: state.lifecycle,
      runtimeLifecycle: state.runtimeLifecycle,
      activePluginCount: health.activePluginCount,
      pluginExecutionEnabled: snapshots.localExecutionEnabled,
      enabledPluginIds,
      ...(state.lastError ? { lastError: state.lastError } : {}),
    },
    health,
    execution: {
      pluginExecutionEnabled: snapshots.localExecutionEnabled,
      enabledPluginIds,
    },
  };
}

async function buildCatalogPayload(ctx: PluginApiContext): Promise<PluginCatalogResponse> {
  const snapshots = await loadPluginSnapshots(ctx);
  const matchaEnabledSet = new Set(snapshots.localEnabledPluginIds);
  const localOpenClawMap = new Map(
    snapshots.localCatalog
      .filter((plugin) => plugin.platform === 'openclaw')
      .map((plugin) => [plugin.id, plugin] as const),
  );
  const openClawPluginIds = normalizePluginIds([
    ...localOpenClawMap.keys(),
    ...snapshots.openClawToolMap.keys(),
  ]);
  const openClawPlugins = openClawPluginIds.map((pluginId) => {
    const local = localOpenClawMap.get(pluginId);
    const tool = snapshots.openClawToolMap.get(pluginId);
    return {
      id: pluginId,
      name: local?.name ?? tool?.name ?? pluginId,
      version: local?.version ?? tool?.version ?? '0.0.0',
      kind: local?.kind ?? 'third-party',
      platform: 'openclaw' as const,
      category: local?.category ?? 'openclaw',
      ...(local?.description || tool?.description ? { description: local?.description ?? tool?.description } : {}),
      enabled: snapshots.openClawConfiguredEnabledPluginIds.includes(pluginId),
    };
  });
  const matchaPlugins = snapshots.localCatalog
    .filter((plugin) => plugin.platform === 'matchaclaw')
    .map((plugin) => ({
      ...plugin,
      enabled: matchaEnabledSet.has(plugin.id),
    }));
  const enabledPluginIds = normalizePluginIds([
    ...snapshots.localEnabledPluginIds,
    ...openClawPlugins.filter((plugin) => plugin.enabled).map((plugin) => plugin.id),
  ]);
  return {
    success: true,
    execution: {
      pluginExecutionEnabled: snapshots.localExecutionEnabled,
      enabledPluginIds,
    },
    plugins: [...openClawPlugins, ...matchaPlugins],
  };
}

export async function handlePluginRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: PluginApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/plugins/runtime' && req.method === 'GET') {
    sendJson(res, 200, await buildRuntimePayload(ctx));
    return true;
  }

  if (url.pathname === '/api/plugins/catalog' && req.method === 'GET') {
    sendJson(res, 200, await buildCatalogPayload(ctx));
    return true;
  }

  if (url.pathname === '/api/plugins/runtime/execution' && req.method === 'PUT') {
    const body = await parseJsonBody<unknown>(req);
    if (!isRecord(body) || typeof body.enabled !== 'boolean') {
      sendJson(res, 400, { success: false, error: 'enabled must be a boolean' });
      return true;
    }
    await ctx.runtimeHost.setExecutionEnabled(body.enabled);
    sendJson(res, 200, await buildRuntimePayload(ctx));
    return true;
  }

  if (url.pathname === '/api/plugins/runtime/enabled-plugins' && req.method === 'PUT') {
    const body = await parseJsonBody<unknown>(req);
    const pluginIds = isRecord(body) ? asStringArray(body.pluginIds) : null;
    if (!pluginIds) {
      sendJson(res, 400, { success: false, error: 'pluginIds must be a string array' });
      return true;
    }
    const desiredPluginIds = normalizePluginIds(pluginIds);
    const snapshots = await loadPluginSnapshots(ctx);
    const openClawPluginIdSet = new Set(
      snapshots.localCatalog
        .filter((plugin) => plugin.platform === 'openclaw')
        .map((plugin) => plugin.id),
    );
    for (const pluginId of snapshots.openClawToolMap.keys()) {
      openClawPluginIdSet.add(pluginId);
    }
    const currentOpenClawEnabledSet = new Set(
      [...snapshots.openClawToolMap.values()]
        .filter((tool) => tool.enabled)
        .map((tool) => tool.id),
    );
    const desiredOpenClawEnabledSet = new Set(
      desiredPluginIds.filter((pluginId) => openClawPluginIdSet.has(pluginId)),
    );
    const pluginIdsToSync = normalizePluginIds([
      ...currentOpenClawEnabledSet,
      ...desiredOpenClawEnabledSet,
    ]);
    if (pluginIdsToSync.length > 0) {
      const configGetResult = await ctx.runtimeHost.request<GatewayRpcEnvelope<ConfigGetResult>>(
        'POST',
        '/api/gateway/rpc',
        { method: 'config.get' },
      );
      if (!configGetResult.data?.success || !configGetResult.data.result?.config) {
        throw new Error(configGetResult.data?.error || 'OpenClaw config.get failed');
      }
      const hash = configGetResult.data.result.hash ?? configGetResult.data.result.baseHash;
      if (typeof hash !== 'string' || !hash.trim()) {
        throw new Error('OpenClaw config hash missing');
      }
      const nextConfig = await applyEnabledPluginIdsToOpenClawConfig(
        configGetResult.data.result.config,
        [...desiredOpenClawEnabledSet],
      );
      const configSetResult = await ctx.runtimeHost.request<GatewayRpcEnvelope<unknown>>(
        'POST',
        '/api/gateway/rpc',
        {
          method: 'config.set',
          params: {
            raw: JSON.stringify(nextConfig),
            baseHash: hash,
          },
        },
      );
      if (!configSetResult.data?.success) {
        throw new Error(configSetResult.data?.error || 'OpenClaw config.set failed');
      }
      await ctx.gatewayManager.reload();
    }
    const desiredMatchaEnabledPluginIds = desiredPluginIds.filter((pluginId) => (
      snapshots.localCatalog.some((plugin) => plugin.platform === 'matchaclaw' && plugin.id === pluginId)
    ));
    await ctx.runtimeHost.setEnabledPluginIds(desiredMatchaEnabledPluginIds);
    sendJson(res, 200, await buildRuntimePayload(ctx));
    return true;
  }

  if (url.pathname === '/api/plugins/runtime/restart' && req.method === 'POST') {
    await ctx.runtimeHost.restart();
    sendJson(res, 200, await buildRuntimePayload(ctx));
    return true;
  }

  return false;
}
