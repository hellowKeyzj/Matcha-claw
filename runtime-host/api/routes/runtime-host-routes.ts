import { RuntimeHostService } from '../../application/runtime-host/service';

interface RuntimeHostRoutesDeps {
  createHealthPayload: () => unknown;
  buildTransportStatsSnapshot: () => unknown;
  syncGatewayConfigLocal: (input: {
    gatewayToken?: string;
    proxyEnabled?: boolean;
    proxyServer?: string;
    proxyBypassRules?: string;
  }) => Promise<{ configuredChannels: string[] }>;
  buildProviderEnvMap: () => {
    keyableProviderTypes: string[];
    envVarByProviderType: Record<string, string>;
  };
  syncProviderAuthBootstrapLocal: () => Promise<{
    syncedApiKeyCount: number;
    defaultProviderId?: string;
  }>;
  collectDiagnosticsBundleLocal: (input: {
    userDataDir: string;
    openclawConfigDir: string;
    appInfo: {
      name: string;
      version: string;
      isPackaged: boolean;
      platform: NodeJS.Platform;
      arch: string;
      electron?: string;
      node: string;
    };
    gatewayStatus?: unknown;
    gatewayRuntimePaths?: unknown;
    licenseGateSnapshot?: unknown;
  }) => Promise<unknown>;
}

interface LocalDispatchResponse {
  status: number;
  data: unknown;
}

export async function handleRuntimeHostRoute(
  method: string,
  routePath: string,
  payload: unknown,
  deps: RuntimeHostRoutesDeps,
): Promise<LocalDispatchResponse | null> {
  const service = new RuntimeHostService({
    createHealthPayload: deps.createHealthPayload,
    buildTransportStatsSnapshot: deps.buildTransportStatsSnapshot,
    syncGatewayConfig: deps.syncGatewayConfigLocal,
    buildProviderEnvMap: deps.buildProviderEnvMap,
    syncProviderAuthBootstrap: deps.syncProviderAuthBootstrapLocal,
    collectDiagnostics: deps.collectDiagnosticsBundleLocal,
  });

  if (method === 'GET' && routePath === '/api/runtime-host/health') {
    return {
      status: 200,
      data: service.health(),
    };
  }

  if (method === 'GET' && routePath === '/api/runtime-host/transport-stats') {
    return {
      status: 200,
      data: service.transportStats(),
    };
  }

  if (method === 'POST' && routePath === '/api/runtime-host/sync-gateway-config') {
    return {
      status: 200,
      data: await service.syncGatewayConfig(payload),
    };
  }

  if (method === 'GET' && routePath === '/api/runtime-host/provider-env-map') {
    return {
      status: 200,
      data: service.providerEnvMap(),
    };
  }

  if (method === 'POST' && routePath === '/api/runtime-host/sync-provider-auth-bootstrap') {
    return {
      status: 200,
      data: await service.syncProviderAuthBootstrap(),
    };
  }

  if (method === 'POST' && routePath === '/api/diagnostics/collect') {
    return await service.collectDiagnostics(payload);
  }

  return null;
}
