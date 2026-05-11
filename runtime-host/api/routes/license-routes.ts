import { routeResponder, type ApplicationResponse, type RuntimeRouteDefinition } from './route-utils';

interface LicenseRouteDeps {
  licenseService: LicenseRouteService;
}

interface LicenseRouteService {
  gate(): Promise<ApplicationResponse>;
  storedKey(): Promise<ApplicationResponse>;
  validate(payload: unknown): Promise<ApplicationResponse>;
  revalidate(): Promise<ApplicationResponse>;
  clear(): Promise<ApplicationResponse>;
}

export const licenseRoutes: readonly RuntimeRouteDefinition<LicenseRouteDeps>[] = [
  { method: 'GET', path: '/api/license/gate', handle: (_context, deps) => routeResponder.result(() => deps.licenseService.gate()) },
  { method: 'GET', path: '/api/license/stored-key', handle: (_context, deps) => routeResponder.result(() => deps.licenseService.storedKey()) },
  { method: 'POST', path: '/api/license/validate', handle: (context, deps) => routeResponder.result(() => deps.licenseService.validate(context.payload)) },
  { method: 'POST', path: '/api/license/revalidate', handle: (_context, deps) => routeResponder.result(() => deps.licenseService.revalidate()) },
  { method: 'POST', path: '/api/license/clear', handle: (_context, deps) => routeResponder.result(() => deps.licenseService.clear()) },
] as const;

