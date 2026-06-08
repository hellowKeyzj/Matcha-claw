import { badRequest, routeResponder, sanitizeReadOnlyRouteResponse, type ApplicationResponse, type RuntimeRouteDefinition } from './route-utils';

interface GatewayRouteDeps {
  gatewayService: GatewayRouteService;
}

interface GatewayRouteService {
  status(): Promise<ApplicationResponse>;
  ready(payload: unknown): Promise<ApplicationResponse>;
  approvePendingControlUiPairingRequests(): Promise<ApplicationResponse>;
}

const LEGACY_GATEWAY_CONTROL_ROUTE_REJECTION = 'Legacy gateway control route is disabled; use /api/capabilities/execute with a gateway-control target';

export const gatewayRoutes: readonly RuntimeRouteDefinition<GatewayRouteDeps>[] = [
  { method: 'GET', path: '/api/gateway/status', handle: (_context, deps) => routeResponder.result(async () => sanitizeReadOnlyRouteResponse(await deps.gatewayService.status())) },
  { method: 'POST', path: '/api/gateway/ready', handle: () => badRequest(LEGACY_GATEWAY_CONTROL_ROUTE_REJECTION) },
  { method: 'POST', path: '/api/gateway/control-ui/auto-approve', handle: () => badRequest(LEGACY_GATEWAY_CONTROL_ROUTE_REJECTION) },
] as const;

