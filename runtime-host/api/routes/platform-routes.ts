import {
  routeResponder,
  type RuntimeRouteDefinition,
} from './route-utils';

interface PlatformRouteDeps {
  readonly platformService: PlatformRouteService;
}

interface PlatformRouteService {
  runtimeHealth(): Promise<unknown>;
  listTools(routeUrl: URL): Promise<unknown>;
  queryTools(payload: unknown): Promise<unknown>;
}

export const platformRoutes: readonly RuntimeRouteDefinition<PlatformRouteDeps>[] = [
  { method: 'GET', path: '/api/platform/runtime/health', handle: (_context, deps) => routeResponder.value(() => deps.platformService.runtimeHealth()) },
  { method: 'GET', path: '/api/platform/tools', handle: (context, deps) => routeResponder.value(() => deps.platformService.listTools(context.routeUrl)) },
  { method: 'POST', path: '/api/platform/tools/query', handle: (context, deps) => routeResponder.value(() => deps.platformService.queryTools(context.payload)) },
] as const;

