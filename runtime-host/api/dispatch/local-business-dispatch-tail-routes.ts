import { resolveDeletedPath } from '../common/http';
import { handleClawHubRoute } from '../routes/clawhub-routes';
import { handleGatewayRoute } from '../routes/gateway-routes';
import { handlePlatformRoute } from '../routes/platform-routes';
import { handlePluginRuntimeRoute } from '../routes/plugin-runtime-routes';
import { handleSecurityRoute } from '../routes/security-routes';
import { handleSessionRoute } from '../routes/session-routes';
import { handleTeamRuntimeRoute } from '../routes/team-runtime-routes';
import { checkUvInstalledLocal, installUvLocal } from '../routes/toolchain-uv-routes';
import { getOpenClawConfigDir } from '../storage/paths';
import type {
  LocalBusinessDispatchContext,
  LocalBusinessDispatchRequest,
  LocalBusinessHandler,
  LocalBusinessHandlerEntry,
  LocalDispatchResponse,
} from './local-business-dispatch-types';

function createPrefixedRouteHandler(
  prefix: string,
  handler: (request: LocalBusinessDispatchRequest) => Promise<LocalDispatchResponse | null>,
): LocalBusinessHandler {
  return async (request) => {
    if (!request.routePath.startsWith(prefix)) {
      return null;
    }
    try {
      return await handler(request);
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  };
}

function handleToolchainUvRoute(request: LocalBusinessDispatchRequest): LocalDispatchResponse | null {
  if (request.method === 'GET' && request.routePath === '/api/toolchain/uv/check') {
    return {
      status: 200,
      data: checkUvInstalledLocal(),
    };
  }
  if (request.method === 'POST' && request.routePath === '/api/toolchain/uv/install') {
    return {
      status: 200,
      data: installUvLocal(),
    };
  }
  return null;
}

export function createTailLocalBusinessHandlers(
  context: LocalBusinessDispatchContext,
): LocalBusinessHandlerEntry[] {
  return [
    {
      key: 'team_runtime',
      handle: createPrefixedRouteHandler('/api/team-runtime/', async (request) => await handleTeamRuntimeRoute(request.method, request.routePath, request.payload)),
    },
    {
      key: 'clawhub',
      handle: createPrefixedRouteHandler('/api/clawhub/', async (request) => await handleClawHubRoute(
        request.method,
        request.routePath,
        request.payload,
        {
          requestParentShellAction: context.requestParentShellAction,
          mapParentTransportResponse: context.mapParentTransportResponse,
        },
      )),
    },
    {
      key: 'toolchain_uv',
      handle: handleToolchainUvRoute,
    },
    {
      key: 'session',
      handle: (request) => handleSessionRoute(request.method, request.routePath, request.payload, {
        getOpenClawConfigDir,
        resolveDeletedPath,
      }),
    },
    {
      key: 'plugin_runtime',
      handle: (request) => handlePluginRuntimeRoute(request.method, request.routePath, request.payload, {
        buildLocalPluginsRuntimePayload: context.buildLocalPluginsRuntimePayload,
        refreshPluginCatalog: context.refreshPluginCatalog,
        setEnabledPluginIds: context.setEnabledPluginIds,
        requestParentShellAction: context.requestParentShellAction,
        pluginExecutionEnabled: context.getPluginExecutionEnabled(),
        enabledPluginIds: context.getEnabledPluginIds(),
        getPluginCatalog: context.getPluginCatalog,
      }),
    },
    {
      key: 'gateway',
      handle: (request) => handleGatewayRoute(request.method, request.routePath, request.payload, {
        openclawBridge: context.openclawBridge,
      }),
    },
    {
      key: 'security',
      handle: (request) => handleSecurityRoute(request.method, request.routePath, request.routeUrl, request.payload, {
        openclawBridge: context.openclawBridge,
      }),
    },
    {
      key: 'platform',
      handle: (request) => handlePlatformRoute(
        request.method,
        request.routePath,
        request.routeUrl,
        request.payload,
        { platformRuntime: context.platformRuntime },
      ),
    },
  ];
}
