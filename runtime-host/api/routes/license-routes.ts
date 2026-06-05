import { routeResponder, type ApplicationResponse, type RuntimeRouteDefinition } from './route-utils';

interface LicenseRouteDeps {
  licenseService: LicenseRouteService;
}

interface LicenseRouteService {
  gate(): Promise<ApplicationResponse>;
  storedKey(): Promise<ApplicationResponse>;
}

export const licenseRoutes: readonly RuntimeRouteDefinition<LicenseRouteDeps>[] = [
  { method: 'GET', path: '/api/license/gate', handle: (_context, deps) => routeResponder.result(() => deps.licenseService.gate()) },
  { method: 'GET', path: '/api/license/stored-key', handle: (_context, deps) => routeResponder.result(() => deps.licenseService.storedKey()) },
] as const;

