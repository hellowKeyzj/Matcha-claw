import {
  decodeRouteParam,
  routeResponder,
  type ApplicationResponse,
  type RuntimeRouteDefinition,
} from './route-utils';

interface ProviderRouteDeps {
  providerAccountsService: ProviderAccountsRouteService;
}

interface ProviderAccountsRouteService {
  list(): Promise<unknown>;
  create(payload: unknown): ApplicationResponse;
  validate(payload: unknown): Promise<unknown>;
  startOAuth(payload: unknown): Promise<ApplicationResponse>;
  cancelOAuth(): Promise<ApplicationResponse>;
  submitOAuth(payload: unknown): Promise<ApplicationResponse>;
  completeBrowser(payload: unknown): Promise<ApplicationResponse>;
  completeDevice(payload: unknown): Promise<ApplicationResponse>;
  getApiKey(accountId: string): Promise<unknown>;
  hasApiKey(accountId: string): Promise<unknown>;
  get(accountId: string): Promise<unknown>;
  update(accountId: string, payload: unknown): ApplicationResponse;
  delete(accountId: string, apiKeyOnly: boolean): ApplicationResponse;
}

export const providerRoutes: readonly RuntimeRouteDefinition<ProviderRouteDeps>[] = [
  { method: 'GET', path: '/api/provider-accounts', handle: (_context, deps) => routeResponder.value(() => deps.providerAccountsService.list()) },
  { method: 'POST', path: '/api/provider-accounts', handle: (context, deps) => routeResponder.result(() => deps.providerAccountsService.create(context.payload)) },
  { method: 'POST', path: '/api/provider-accounts/validate', handle: (context, deps) => routeResponder.value(() => deps.providerAccountsService.validate(context.payload)) },
  { method: 'POST', path: '/api/provider-accounts/oauth/start', handle: (context, deps) => routeResponder.result(() => deps.providerAccountsService.startOAuth(context.payload)) },
  { method: 'POST', path: '/api/provider-accounts/oauth/cancel', handle: (_context, deps) => routeResponder.result(() => deps.providerAccountsService.cancelOAuth()) },
  { method: 'POST', path: '/api/provider-accounts/oauth/submit', handle: (context, deps) => routeResponder.result(() => deps.providerAccountsService.submitOAuth(context.payload)) },
  { method: 'POST', path: '/api/provider-accounts/oauth/complete-browser', handle: (context, deps) => routeResponder.result(() => deps.providerAccountsService.completeBrowser(context.payload)) },
  { method: 'POST', path: '/api/provider-accounts/oauth/complete-device', handle: (context, deps) => routeResponder.result(() => deps.providerAccountsService.completeDevice(context.payload)) },
  {
    method: 'GET',
    pattern: /^\/api\/provider-accounts\/([^/]+)\/api-key$/,
    handle: (_context, deps, match) => routeResponder.value(() => deps.providerAccountsService.getApiKey(decodeRouteParam(match.params[0]))),
  },
  {
    method: 'GET',
    pattern: /^\/api\/provider-accounts\/([^/]+)\/has-api-key$/,
    handle: (_context, deps, match) => routeResponder.value(() => deps.providerAccountsService.hasApiKey(decodeRouteParam(match.params[0]))),
  },
  {
    method: 'GET',
    pattern: /^\/api\/provider-accounts\/([^/]+)$/,
    handle: (_context, deps, match) => routeResponder.value(() => deps.providerAccountsService.get(decodeRouteParam(match.params[0]))),
  },
  {
    method: 'PUT',
    pattern: /^\/api\/provider-accounts\/([^/]+)$/,
    handle: (context, deps, match) => routeResponder.result(() => deps.providerAccountsService.update(decodeRouteParam(match.params[0]), context.payload)),
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/provider-accounts\/([^/]+)$/,
    handle: (context, deps, match) => routeResponder.result(() => deps.providerAccountsService.delete(
      decodeRouteParam(match.params[0]),
      context.routeUrl.searchParams.get('apiKeyOnly') === '1',
    )),
  },
] as const;

