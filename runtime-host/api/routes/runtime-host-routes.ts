import { routeResponder, sanitizeReadOnlyRouteResponse, type ApplicationResponse, type RuntimeRouteDefinition } from './route-utils';

interface RuntimeHostRouteService {
  health: () => unknown;
  transportStats: () => unknown;
  providerEnvMap: () => unknown;
  hostBootstrapSettings: () => Promise<ApplicationResponse>;
  gatewayLaunchPlan: () => Promise<ApplicationResponse>;
  runtimeJobs: (payload: unknown) => unknown;
}

interface RuntimeHostRouteDeps extends RuntimeHostRouteService {
  teamRuntimeWebhookAuth?: {
    getPublicAuthProjection: () => Promise<unknown>;
  };
}

export const runtimeHostRoutes: readonly RuntimeRouteDefinition<RuntimeHostRouteDeps>[] = [
  { method: 'GET', path: '/api/runtime-host/health', handle: (_context, deps) => routeResponder.ok(deps.health()) },
  { method: 'GET', path: '/api/runtime-host/transport-stats', handle: (_context, deps) => routeResponder.ok(deps.transportStats()) },
  { method: 'GET', path: '/api/runtime-host/provider-env-map', handle: (_context, deps) => routeResponder.ok(sanitizeReadOnlyRouteResponse(deps.providerEnvMap())) },
  { method: 'GET', path: '/api/runtime-host/host-bootstrap-settings', handle: (_context, deps) => routeResponder.result(async () => sanitizeReadOnlyRouteResponse(await deps.hostBootstrapSettings())) },
  { method: 'GET', path: '/api/runtime-host/gateway-launch-plan', handle: (_context, deps) => routeResponder.result(async () => sanitizeReadOnlyRouteResponse(await deps.gatewayLaunchPlan())) },
  { method: 'GET', path: '/api/runtime-host/team-webhook-auth', handle: (_context, deps) => routeResponder.result(() => {
    if (!deps.teamRuntimeWebhookAuth) {
      throw new Error('TeamRun webhook auth service is not available.');
    }
    return deps.teamRuntimeWebhookAuth.getPublicAuthProjection();
  }) },
  {
    method: 'GET',
    path: '/api/runtime-host/jobs',
    handle: (context, deps) => routeResponder.ok(sanitizeReadOnlyRouteResponse(deps.runtimeJobs({
      type: context.routeUrl.searchParams.get('type') ?? undefined,
    }))),
  },
] as const;

