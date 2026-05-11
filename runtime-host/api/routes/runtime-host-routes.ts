import { routeResponder, type ApplicationResponse, type RuntimeRouteDefinition } from './route-utils';

interface RuntimeHostRouteService {
  health: () => unknown;
  transportStats: () => unknown;
  prepareGatewayLaunch: (payload: unknown) => Promise<ApplicationResponse>;
  providerEnvMap: () => unknown;
  hostBootstrapSettings: () => Promise<ApplicationResponse>;
  gatewayLaunchPlan: () => Promise<ApplicationResponse>;
  syncProviderAuthBootstrap: () => ApplicationResponse;
  gatewayLifecycle: (payload: unknown) => ApplicationResponse | unknown;
  collectDiagnostics: (payload: unknown) => Promise<ApplicationResponse>;
  runtimeJobs: (payload: unknown) => unknown;
  runtimeJob: (payload: unknown) => ApplicationResponse | unknown;
}

export const runtimeHostRoutes: readonly RuntimeRouteDefinition<RuntimeHostRouteService>[] = [
  { method: 'GET', path: '/api/runtime-host/health', handle: (_context, service) => routeResponder.ok(service.health()) },
  { method: 'GET', path: '/api/runtime-host/transport-stats', handle: (_context, service) => routeResponder.ok(service.transportStats()) },
  { method: 'POST', path: '/api/runtime-host/prepare-gateway-launch', handle: (context, service) => routeResponder.result(() => service.prepareGatewayLaunch(context.payload)) },
  { method: 'GET', path: '/api/runtime-host/provider-env-map', handle: (_context, service) => routeResponder.ok(service.providerEnvMap()) },
  { method: 'GET', path: '/api/runtime-host/host-bootstrap-settings', handle: (_context, service) => routeResponder.result(() => service.hostBootstrapSettings()) },
  { method: 'GET', path: '/api/runtime-host/gateway-launch-plan', handle: (_context, service) => routeResponder.result(() => service.gatewayLaunchPlan()) },
  { method: 'POST', path: '/api/runtime-host/sync-provider-auth-bootstrap', handle: (_context, service) => routeResponder.result(() => service.syncProviderAuthBootstrap()) },
  { method: 'POST', path: '/api/runtime-host/gateway-lifecycle', handle: (context, service) => routeResponder.result(() => service.gatewayLifecycle(context.payload)) },
  {
    method: 'GET',
    path: '/api/runtime-host/jobs',
    handle: (context, service) => routeResponder.ok(service.runtimeJobs({
      type: context.routeUrl.searchParams.get('type') ?? undefined,
    })),
  },
  { method: 'POST', path: '/api/runtime-host/jobs/get', handle: (context, service) => routeResponder.result(() => service.runtimeJob(context.payload)) },
  { method: 'POST', path: '/api/diagnostics/collect', handle: (context, service) => routeResponder.result(() => service.collectDiagnostics(context.payload)) },
] as const;

