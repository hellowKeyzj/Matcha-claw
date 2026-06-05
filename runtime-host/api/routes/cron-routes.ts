import {
  routeResponder,
  type ApplicationResponse,
  type RuntimeRouteDefinition,
} from './route-utils';

interface CronRouteDeps {
  cronService: CronRouteService;
}

interface CronRouteService {
  usageRecent(payload: unknown, routeUrl: URL): Promise<unknown>;
  listJobs(): Promise<unknown>;
  sessionHistory(routeUrl: URL): Promise<ApplicationResponse>;
}

export const cronRoutes: readonly RuntimeRouteDefinition<CronRouteDeps>[] = [
  {
    method: 'GET',
    path: '/api/runtime-host/usage/recent',
    handle: (context, deps) => routeResponder.value(() => deps.cronService.usageRecent(context.payload, context.routeUrl)),
  },
  {
    method: 'GET',
    path: '/api/cron/jobs',
    handle: (_context, deps) => routeResponder.value(() => deps.cronService.listJobs()),
  },
  {
    method: 'GET',
    path: '/api/cron/session-history',
    handle: (context, deps) => routeResponder.result(() => deps.cronService.sessionHistory(context.routeUrl)),
  },
] as const;

