import { routeResponder, type RuntimeRouteDefinition } from './route-utils';

export interface ToolchainUvRouteService {
  checkInstalled(): Promise<boolean>;
}

export interface ToolchainUvRouteDeps {
  toolchainUvService: ToolchainUvRouteService;
}

export const toolchainUvRoutes: readonly RuntimeRouteDefinition<ToolchainUvRouteDeps>[] = [
  {
    method: 'GET',
    path: '/api/toolchain/uv/check',
    handle: (_context, deps) => routeResponder.value(() => deps.toolchainUvService.checkInstalled()),
  },
] as const;

