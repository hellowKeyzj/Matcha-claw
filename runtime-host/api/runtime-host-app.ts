import {
  DEFAULT_PORT,
  TRANSPORT_VERSION,
} from './common/constants';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  buildLocalPluginsRuntimePayload as buildLocalPluginsRuntimePayloadFromState,
  buildLocalRuntimeHealth as buildLocalRuntimeHealthFromState,
  buildLocalRuntimeState as buildLocalRuntimeStateFromState,
  buildTransportStatsSnapshot as buildTransportStatsSnapshotFromState,
  createHealthPayload as createHealthPayloadFromState,
} from './common/runtime-state';
import { sendJson } from './common/http';
import { handleDispatchRoute } from './dispatch/dispatch-route-handler';
import { createLocalBusinessDispatcher } from './dispatch/local-business-dispatch';
import { createParentTransportClient } from './dispatch/parent-transport';
import { createOpenClawBridge, createGatewayClient } from '../openclaw-bridge';
import { createRuntimeHostPlatformRoot } from './platform/runtime-root';
import { getSessionRuntimeService } from './routes/session-routes';
import { getOpenClawConfigDir } from './storage/paths';
import {
  mergePluginCatalogSnapshots,
} from '../application/plugins/catalog';
import { pickCatalogGroup } from '../application/plugins/plugin-groups';
import {
  ensureConfiguredManagedPluginsInstalled,
  listEnabledPluginIdsFromConfig,
  listRuntimePluginCatalog,
  setRuntimeEnabledPluginIds,
} from '../application/plugins/runtime-plugin-service';
import { createRuntimeLogger } from '../shared/logger';

const logger = createRuntimeLogger('runtime-host-app');

const port = Number.parseInt(process.env.MATCHACLAW_RUNTIME_HOST_PORT || '', 10) || DEFAULT_PORT;
function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Missing required runtime-host env: ${name}`);
  }
  return value;
}
const parentApiBaseUrl = readRequiredEnv('MATCHACLAW_RUNTIME_HOST_PARENT_API_BASE_URL').replace(/\/+$/, '');
const parentDispatchToken = readRequiredEnv('MATCHACLAW_RUNTIME_HOST_PARENT_DISPATCH_TOKEN');
const startedAtMs = Date.now();
const fallbackEnabledPluginIds = (() => {
  try {
    const rawEnabledPluginIds = process.env.MATCHACLAW_RUNTIME_HOST_ENABLED_PLUGIN_IDS;
    if (!rawEnabledPluginIds) {
      return [] as string[];
    }
    const parsed = JSON.parse(rawEnabledPluginIds);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [] as string[];
  }
})();
let lifecycle = 'running';
let enabledPluginIds: string[] = listEnabledPluginIdsFromConfig();
if (enabledPluginIds.length === 0 && fallbackEnabledPluginIds.length > 0) {
  enabledPluginIds = [...fallbackEnabledPluginIds];
}
let pluginCatalog: Array<Record<string, any>> = [];
const transportStats = {
  totalDispatchRequests: 0,
  localBusinessHandled: 0,
  unhandledRouteCount: 0,
  badRequestRejected: 0,
  dispatchInternalError: 0,
};

const parentTransportClient = createParentTransportClient({
  parentApiBaseUrl,
  parentDispatchToken,
});
const {
  requestParentShellAction,
  emitParentGatewayEvent,
  mapParentTransportResponse,
} = parentTransportClient;
let sessionRuntimeService: ReturnType<typeof getSessionRuntimeService> | null = null;
const gatewayClient = createGatewayClient({
  onGatewayNotification: (notification) => {
    void emitParentGatewayEvent('gateway:notification', notification).catch(() => {
      // runtime-host 与主进程短暂断连时允许丢弃单次事件，由主链路重试恢复
    });
  },
  onGatewayConversationEvent: (payload) => {
    const sessionUpdates = sessionRuntimeService?.consumeGatewayConversationEvent(payload) ?? [];
    for (const sessionUpdate of sessionUpdates) {
      void emitParentGatewayEvent('session:update', sessionUpdate).catch(() => {
        // runtime-host 与主进程短暂断连时允许丢弃单次事件，由主链路重试恢复
      });
    }
  },
  onGatewayChannelStatus: (payload) => {
    void emitParentGatewayEvent('gateway:channel-status', payload).catch(() => {
      // runtime-host 与主进程短暂断连时允许丢弃单次事件，由主链路重试恢复
    });
  },
  onGatewayError: (error) => {
    void emitParentGatewayEvent('gateway:error', { message: error.message }).catch(() => {
      // runtime-host 与主进程短暂断连时允许丢弃单次事件，由主链路重试恢复
    });
  },
  onGatewayConnectionState: (payload) => {
    void emitParentGatewayEvent('gateway:connection', payload).catch(() => {
      // runtime-host 与主进程短暂断连时允许丢弃单次事件，由主链路重试恢复
    });
  },
});
const openclawBridge = createOpenClawBridge(gatewayClient);
const platformRuntime = createRuntimeHostPlatformRoot(openclawBridge);
sessionRuntimeService = getSessionRuntimeService({
  getOpenClawConfigDir,
  resolveDeletedPath: (path) => `${path}.deleted`,
  openclawBridge,
});

let injectedPluginCatalog: Array<Record<string, any>> = [];
try {
  const rawPluginCatalog = process.env.MATCHACLAW_RUNTIME_HOST_PLUGIN_CATALOG;
  if (rawPluginCatalog) {
    const parsed = JSON.parse(rawPluginCatalog);
    if (Array.isArray(parsed)) {
      injectedPluginCatalog = parsed.filter((item) => {
        if (!item || typeof item !== 'object') return false;
        const candidate = item;
        return typeof candidate.id === 'string'
          && typeof candidate.name === 'string'
          && typeof candidate.version === 'string'
          && typeof candidate.kind === 'string'
          && typeof candidate.category === 'string';
      }).map((item) => ({
        ...item,
        group: item.group === 'channel' || item.group === 'model' || item.group === 'general'
          ? item.group
          : pickCatalogGroup({
            id: typeof item.id === 'string' ? item.id : undefined,
            category: item.category,
            description: typeof item.description === 'string' ? item.description : undefined,
            controlMode: item.controlMode === 'channel-config' ? 'channel-config' : 'manual',
          }),
        platform: item.platform === 'matchaclaw' ? 'matchaclaw' : 'openclaw',
      }));
    }
  }
} catch {
  injectedPluginCatalog = [];
}
pluginCatalog = [...injectedPluginCatalog];

async function refreshPluginCatalog() {
  const enabledFromConfig = listEnabledPluginIdsFromConfig();
  try {
    const discoveredCatalog = await listRuntimePluginCatalog();
    pluginCatalog = mergePluginCatalogSnapshots(discoveredCatalog, injectedPluginCatalog);
    enabledPluginIds = enabledFromConfig.length > 0 ? enabledFromConfig : [...fallbackEnabledPluginIds];
  } catch (error) {
    pluginCatalog = [...injectedPluginCatalog];
    enabledPluginIds = enabledFromConfig.length > 0 ? enabledFromConfig : [...fallbackEnabledPluginIds];
    logger.warn('failed to refresh plugin catalog', error);
  }
}

function createHealthPayload() {
  return createHealthPayloadFromState(lifecycle, startedAtMs);
}

function buildRuntimeStateParams() {
  return {
    lifecycle,
    enabledPluginIds,
    pluginCatalog,
  };
}

function buildLocalRuntimeState() {
  return buildLocalRuntimeStateFromState(buildRuntimeStateParams());
}

function buildLocalRuntimeHealth(state) {
  return buildLocalRuntimeHealthFromState(state);
}

function buildTransportStatsSnapshot() {
  return buildTransportStatsSnapshotFromState(transportStats);
}

function buildLocalPluginsRuntimePayload() {
  return buildLocalPluginsRuntimePayloadFromState(buildRuntimeStateParams());
}

const tryHandleLocalBusinessDispatch = createLocalBusinessDispatcher({
  buildLocalRuntimeState,
  buildLocalRuntimeHealth,
  buildTransportStatsSnapshot,
  buildLocalPluginsRuntimePayload,
  refreshPluginCatalog,
  getEnabledPluginIds: () => enabledPluginIds,
  getPluginCatalog: () => pluginCatalog,
  openclawBridge,
  platformRuntime: platformRuntime.facade,
  requestParentShellAction,
  mapParentTransportResponse,
  setEnabledPluginIds: async (pluginIds) => {
    enabledPluginIds = await setRuntimeEnabledPluginIds(pluginIds);
    return enabledPluginIds;
  },
});

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const method = req.method || 'GET';
  const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);

  if (method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, createHealthPayload());
    return;
  }

  if (method === 'POST' && url.pathname === '/lifecycle/restart') {
    lifecycle = 'running';
    sendJson(res, 200, { version: TRANSPORT_VERSION, success: true, lifecycle });
    return;
  }

  if (method === 'POST' && url.pathname === '/lifecycle/stop') {
    lifecycle = 'stopped';
    sendJson(res, 200, { version: TRANSPORT_VERSION, success: true, lifecycle });
    setImmediate(() => {
      process.exit(0);
    });
    return;
  }

  if (method === 'POST' && url.pathname === '/dispatch') {
    handleDispatchRoute(req, res, {
      transportStats,
      tryHandleLocalBusinessDispatch,
    });
    return;
  }

  sendJson(res, 404, {
    version: TRANSPORT_VERSION,
    success: false,
    status: 404,
    error: {
      code: 'NOT_FOUND',
      message: `No route for ${method} ${url.pathname}`,
    },
  });
});

function shutdown() {
  lifecycle = 'stopped';
  gatewayClient.close();
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => {
    process.exit(1);
  }, 1500).unref();
}

export function startRuntimeHostProcess() {
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  void ensureConfiguredManagedPluginsInstalled()
    .then(async () => {
      await refreshPluginCatalog();
      server.listen(port, '127.0.0.1', () => {
        logger.info(`listening on http://127.0.0.1:${port}`);
      });
    })
    .catch((error) => {
      logger.error('failed to initialize runtime plugins', error);
      process.exit(1);
    });

  return server;
}
