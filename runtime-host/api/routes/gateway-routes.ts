import { routeResponder, type ApplicationResponse, type RuntimeRouteDefinition } from './route-utils';

interface GatewayRouteDeps {
  gatewayService: GatewayRouteService;
}

interface GatewayRouteService {
  status(): Promise<ApplicationResponse>;
  ready(payload: unknown): Promise<ApplicationResponse>;
}

export const gatewayRoutes: readonly RuntimeRouteDefinition<GatewayRouteDeps>[] = [
  { method: 'GET', path: '/api/gateway/status', handle: (_context, deps) => routeResponder.result(() => deps.gatewayService.status()) },
  { method: 'POST', path: '/api/gateway/ready', handle: (context, deps) => routeResponder.result(() => deps.gatewayService.ready(context.payload)) },
] as const;

