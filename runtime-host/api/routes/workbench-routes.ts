import {
  routeResponder,
  type RuntimeRouteDefinition,
} from './route-utils';

interface WorkbenchRouteDeps {
  workbenchService: WorkbenchRouteService;
}

interface WorkbenchRouteService {
  bootstrap(): unknown;
}

export const workbenchRoutes: readonly RuntimeRouteDefinition<WorkbenchRouteDeps>[] = [
  {
    method: 'GET',
    path: '/api/workbench/bootstrap',
    handle: (_context, deps) => routeResponder.ok(deps.workbenchService.bootstrap()),
  },
] as const;

