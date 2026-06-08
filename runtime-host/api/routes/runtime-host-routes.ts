import { routeResponder, sanitizeReadOnlyRouteResponse, type ApplicationResponse, type RuntimeRouteDefinition } from './route-utils';

interface RuntimeHostRouteService {
  health: () => unknown;
  transportStats: () => unknown;
  providerEnvMap: () => unknown;
  hostBootstrapSettings: () => Promise<ApplicationResponse>;
  gatewayLaunchPlan: () => Promise<ApplicationResponse>;
  runtimeJobs: (payload: unknown) => unknown;
}

export const runtimeHostRoutes: readonly RuntimeRouteDefinition<RuntimeHostRouteService>[] = [
  { method: 'GET', path: '/api/runtime-host/health', handle: (_context, service) => routeResponder.ok(service.health()) },
  { method: 'GET', path: '/api/runtime-host/transport-stats', handle: (_context, service) => routeResponder.ok(service.transportStats()) },
  { method: 'GET', path: '/api/runtime-host/provider-env-map', handle: (_context, service) => routeResponder.ok(sanitizeReadOnlyRouteResponse(service.providerEnvMap())) },
  { method: 'GET', path: '/api/runtime-host/host-bootstrap-settings', handle: (_context, service) => routeResponder.result(async () => sanitizeReadOnlyRouteResponse(await service.hostBootstrapSettings())) },
  { method: 'GET', path: '/api/runtime-host/gateway-launch-plan', handle: (_context, service) => routeResponder.result(async () => sanitizeReadOnlyRouteResponse(await service.gatewayLaunchPlan())) },
  {
    method: 'GET',
    path: '/api/runtime-host/jobs',
    handle: (context, service) => routeResponder.ok(sanitizeReadOnlyRouteResponse(service.runtimeJobs({
      type: context.routeUrl.searchParams.get('type') ?? undefined,
    }))),
  },
] as const;

