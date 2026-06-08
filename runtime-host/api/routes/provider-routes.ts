import {
  badRequest,
  decodeRouteParam,
  routeResponder,
  type RuntimeRouteDefinition,
} from './route-utils';

interface ProviderRouteDeps {
  providerAccountsService: ProviderAccountsRouteService;
}

interface ProviderAccountsRouteService {
  list(): Promise<unknown>;
  validate(payload: unknown): Promise<unknown>;
  getApiKey(accountId: string): Promise<unknown>;
  hasApiKey(accountId: string): Promise<unknown>;
  get(accountId: string): Promise<unknown>;
}

const LEGACY_PROVIDER_SECRET_ROUTE_REJECTION = 'Legacy provider secret route is disabled; use /api/capabilities/execute with a provider target';

export const providerRoutes: readonly RuntimeRouteDefinition<ProviderRouteDeps>[] = [
  { method: 'GET', path: '/api/provider-accounts', handle: (_context, deps) => routeResponder.value(() => deps.providerAccountsService.list()) },
  { method: 'POST', path: '/api/provider-accounts/validate', handle: () => badRequest(LEGACY_PROVIDER_SECRET_ROUTE_REJECTION) },
  {
    method: 'GET',
    pattern: /^\/api\/provider-accounts\/([^/]+)\/api-key$/,
    handle: () => badRequest(LEGACY_PROVIDER_SECRET_ROUTE_REJECTION),
  },
  {
    method: 'GET',
    pattern: /^\/api\/provider-accounts\/([^/]+)\/has-api-key$/,
    handle: (_context, deps, match) => routeResponder.value(() => deps.providerAccountsService.hasApiKey(decodeRouteParam(match.params[0]))),
  },
  {
    method: 'GET',
    pattern: /^\/api\/provider-accounts\/([^/]+)$/,
    handle: () => badRequest(LEGACY_PROVIDER_SECRET_ROUTE_REJECTION),
  },
] as const;

