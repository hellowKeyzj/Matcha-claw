import {
  decodeRouteParam,
  routeResponder,
  type RuntimeRouteDefinition,
} from './route-utils';

interface ProviderModelsRouteDeps {
  providerModelsService: ProviderModelsRouteService;
}

interface ProviderModelsRouteService {
  readAll(): Promise<unknown>;
  readSelectable(): Promise<unknown>;
  read(credentialId: string): Promise<unknown>;
}

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
    handle: (_context, deps, match) => routeResponder.value(() => deps.providerModelsService.read(decodeRouteParam(match.params[0]))),
  },
] as const;
