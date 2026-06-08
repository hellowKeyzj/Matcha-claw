import { routeResponder, sanitizeReadOnlyRouteResponse, type ApplicationResponse, type RuntimeRouteDefinition } from './route-utils';

interface LicenseRouteDeps {
  licenseService: LicenseRouteService;
}

interface LicenseRouteService {
  gate(): Promise<ApplicationResponse>;
  storedKey(): Promise<ApplicationResponse>;
}

export const licenseRoutes: readonly RuntimeRouteDefinition<LicenseRouteDeps>[] = [
  { method: 'GET', path: '/api/license/gate', handle: (_context, deps) => routeResponder.result(async () => sanitizeReadOnlyRouteResponse(await deps.licenseService.gate())) },
  { method: 'GET', path: '/api/license/stored-key', handle: (_context, deps) => routeResponder.result(async () => sanitizeReadOnlyRouteResponse(await deps.licenseService.storedKey(), ['key'])) },
] as const;

