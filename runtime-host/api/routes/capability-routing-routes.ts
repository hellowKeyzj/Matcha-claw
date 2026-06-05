import {
  routeResponder,
  type RuntimeRouteDefinition,
} from './route-utils';

interface CapabilityRoutingRouteDeps {
  capabilityRoutingService: CapabilityRoutingRouteService;
}

interface CapabilityRoutingRouteService {
  read(): Promise<unknown>;
}

export const capabilityRoutingRoutes: readonly RuntimeRouteDefinition<CapabilityRoutingRouteDeps>[] = [
  {
    method: 'GET',
    path: '/api/capability-routing',
    handle: (_context, deps) => routeResponder.value(() => deps.capabilityRoutingService.read()),
  },
] as const;
