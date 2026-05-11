import { accepted, routeResponder, type RuntimeRouteDefinition } from './route-utils';

export interface ToolchainUvRouteService {
  checkInstalled(): Promise<boolean>;
  install(): unknown;
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
  {
    method: 'POST',
    path: '/api/toolchain/uv/install',
    handle: (_context, deps) => accepted(deps.toolchainUvService.install()),
  },
] as const;

