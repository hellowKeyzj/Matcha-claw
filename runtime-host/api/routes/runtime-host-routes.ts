import { routeResponder, type ApplicationResponse, type RuntimeRouteDefinition } from './route-utils';

interface RuntimeHostRouteService {
  health: () => unknown;
  transportStats: () => unknown;
  providerEnvMap: () => unknown;
  hostBootstrapSettings: () => Promise<ApplicationResponse>;
  gatewayLaunchPlan: () => Promise<ApplicationResponse>;
  runtimeJobs: (payload: unknown) => unknown;
  runtimeJob: (payload: unknown) => ApplicationResponse | unknown;
}

export const runtimeHostRoutes: readonly RuntimeRouteDefinition<RuntimeHostRouteService>[] = [
  { method: 'GET', path: '/api/runtime-host/health', handle: (_context, service) => routeResponder.ok(service.health()) },
  { method: 'GET', path: '/api/runtime-host/transport-stats', handle: (_context, service) => routeResponder.ok(service.transportStats()) },
  { method: 'GET', path: '/api/runtime-host/provider-env-map', handle: (_context, service) => routeResponder.ok(service.providerEnvMap()) },
  { method: 'GET', path: '/api/runtime-host/host-bootstrap-settings', handle: (_context, service) => routeResponder.result(() => service.hostBootstrapSettings()) },
  { method: 'GET', path: '/api/runtime-host/gateway-launch-plan', handle: (_context, service) => routeResponder.result(() => service.gatewayLaunchPlan()) },
  {
    method: 'GET',
    path: '/api/runtime-host/jobs',
    handle: (context, service) => routeResponder.ok(service.runtimeJobs({
      type: context.routeUrl.searchParams.get('type') ?? undefined,
    })),
  },
  { method: 'POST', path: '/api/runtime-host/jobs/get', handle: (context, service) => routeResponder.result(() => service.runtimeJob(context.payload)) },
] as const;

