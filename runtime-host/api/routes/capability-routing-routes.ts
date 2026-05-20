import {
  routeResponder,
  type ApplicationResponse,
  type RuntimeRouteDefinition,
} from './route-utils';

interface CapabilityRoutingRouteDeps {
  capabilityRoutingService: CapabilityRoutingRouteService;
}

interface CapabilityRoutingRouteService {
  read(): Promise<unknown>;
  write(payload: unknown): Promise<ApplicationResponse>;
}

export const capabilityRoutingRoutes: readonly RuntimeRouteDefinition<CapabilityRoutingRouteDeps>[] = [
  {
    method: 'GET',
    path: '/api/capability-routing',
    handle: (_context, deps) => routeResponder.value(() => deps.capabilityRoutingService.read()),
  },
  {
    method: 'PUT',
    path: '/api/capability-routing',
    handle: (context, deps) => routeResponder.result(() => deps.capabilityRoutingService.write(context.payload)),
  },
] as const;
