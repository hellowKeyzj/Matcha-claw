import {
  badRequest,
  routeResponder,
  type RuntimeRouteDefinition,
} from './route-utils';

interface ProviderModelsRouteDeps {
  providerModelsService: ProviderModelsRouteService;
}

interface ProviderModelsRouteService {
  readAll(): Promise<unknown>;
  readSelectable(): Promise<unknown>;
}

const LEGACY_PROVIDER_MODEL_DETAIL_ROUTE_REJECTION = 'Legacy provider model detail route is disabled; use /api/capabilities/execute with a provider target';

export const providerModelsRoutes: readonly RuntimeRouteDefinition<ProviderModelsRouteDeps>[] = [
  {
    method: 'GET',
    path: '/api/provider-models',
    handle: (_context, deps) => routeResponder.value(() => deps.providerModelsService.readAll()),
  },
  {
    method: 'GET',
    path: '/api/provider-models/selectable',
    handle: (_context, deps) => routeResponder.value(() => deps.providerModelsService.readSelectable()),
  },
  {
    method: 'GET',
    pattern: /^\/api\/provider-models\/([^/]+)$/,
    handle: () => badRequest(LEGACY_PROVIDER_MODEL_DETAIL_ROUTE_REJECTION),
  },
] as const;
