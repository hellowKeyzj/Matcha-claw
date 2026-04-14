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
import {
  discoverPluginCatalogLocal,
  mergePluginCatalogSnapshots,
} from '../application/plugins/catalog';
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
let lifecycle = 'running';
let pluginExecutionEnabled = process.env.MATCHACLAW_RUNTIME_HOST_PLUGIN_EXECUTION_ENABLED !== '0';
let enabledPluginIds: string[] = [];
let pluginCatalog: Array<Record<string, any>> = [];
const transportStats = {
  totalDispatchRequests: 0,
  localBusinessHandled: 0,
  executionSyncHandled: 0,
  executionSyncFailed: 0,
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
  requestParentExecutionSync,
  emitParentGatewayEvent,
  mapParentTransportResponse,
} = parentTransportClient;
const gatewayClient = createGatewayClient({
  onGatewayNotification: (notification) => {
    void emitParentGatewayEvent('gateway:notification', notification).catch(() => {
      // runtime-host 与主进程短暂断连时允许丢弃单次事件，由主链路重试恢复
    });
  },
  onGatewayConversationEvent: (payload) => {
    void emitParentGatewayEvent('gateway:conversation-event', payload).catch(() => {
      // runtime-host 与主进程短暂断连时允许丢弃单次事件，由主链路重试恢复
    });
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

try {
  const rawEnabledPluginIds = process.env.MATCHACLAW_RUNTIME_HOST_ENABLED_PLUGIN_IDS;
  if (rawEnabledPluginIds) {
    const parsed = JSON.parse(rawEnabledPluginIds);
    if (Array.isArray(parsed)) {
      enabledPluginIds = parsed.filter((item) => typeof item === 'string');
    }
  }
} catch {
  enabledPluginIds = [];
}

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
        platform: item.platform === 'matchaclaw' ? 'matchaclaw' : 'openclaw',
      }));
    }
  }
} catch {
  injectedPluginCatalog = [];
}
pluginCatalog = [...injectedPluginCatalog];

async function refreshPluginCatalog() {
  try {
    const discoveredCatalog = await discoverPluginCatalogLocal();
    pluginCatalog = mergePluginCatalogSnapshots(discoveredCatalog, injectedPluginCatalog);
  } catch (error) {
    pluginCatalog = [...injectedPluginCatalog];
    logger.warn('failed to refresh plugin catalog', error);
  }
}

function createHealthPayload() {
  return createHealthPayloadFromState(lifecycle, startedAtMs);
}

function buildRuntimeStateParams() {
  return {
    lifecycle,
    pluginExecutionEnabled,
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
  getPluginExecutionEnabled: () => pluginExecutionEnabled,
  getEnabledPluginIds: () => enabledPluginIds,
  getPluginCatalog: () => pluginCatalog,
  openclawBridge,
  platformRuntime: platformRuntime.facade,
  requestParentShellAction,
  mapParentTransportResponse,
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
      requestParentExecutionSync,
      buildLocalPluginsRuntimePayload,
      setPluginExecutionEnabled: (enabled) => {
        pluginExecutionEnabled = enabled;
      },
      setEnabledPluginIds: (pluginIds) => {
        enabledPluginIds = pluginIds;
      },
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

  void refreshPluginCatalog()
    .finally(() => {
      server.listen(port, '127.0.0.1', () => {
        logger.info(`listening on http://127.0.0.1:${port}`);
      });
    });

  return server;
}
