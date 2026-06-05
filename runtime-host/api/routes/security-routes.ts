import {
  routeResponder,
  type RuntimeRouteDefinition,
} from './route-utils';

interface SecurityRouteDeps {
  securityService: SecurityRouteService;
}

interface SecurityRouteService {
  readPolicy(): Promise<unknown>;
  listRuleCatalog(platform: string | null): unknown;
  queryAudit(routeUrl: URL): Promise<unknown>;
}

export const securityRoutes: readonly RuntimeRouteDefinition<SecurityRouteDeps>[] = [
  { method: 'GET', path: '/api/security', handle: (_context, deps) => routeResponder.value(() => deps.securityService.readPolicy()) },
  { method: 'GET', path: '/api/security/destructive-rule-catalog', handle: (context, deps) => routeResponder.ok(deps.securityService.listRuleCatalog(context.routeUrl.searchParams.get('platform'))) },
  { method: 'GET', path: '/api/security/audit', handle: (context, deps) => routeResponder.value(() => deps.securityService.queryAudit(context.routeUrl)) },
] as const;

