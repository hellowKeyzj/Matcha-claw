import {
  readRecord,
  routeResponder,
  type RuntimeRouteDefinition,
} from './route-utils';

interface ClawHubRouteDeps {
  clawHubService: ClawHubRouteService;
}

interface ClawHubRouteService {
  search(body: Record<string, unknown>): Promise<unknown>;
}

export const clawHubRoutes: readonly RuntimeRouteDefinition<ClawHubRouteDeps>[] = [
  {
    method: 'POST',
    path: '/api/clawhub/search',
    handle: async (context, deps) => routeResponder.ok({
      success: true,
      results: await deps.clawHubService.search(readRecord(context.payload)),
    }),
  },
] as const;

