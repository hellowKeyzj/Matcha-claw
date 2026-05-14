import {
  decodeRouteParam,
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
  createJob(payload: unknown): Promise<ApplicationResponse>;
  updateJob(jobId: string, payload: unknown): Promise<ApplicationResponse>;
  deleteJob(jobId: string): Promise<ApplicationResponse>;
  toggleJob(payload: unknown): ApplicationResponse;
  trigger(payload: unknown): ApplicationResponse;
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
  {
    method: 'POST',
    path: '/api/cron/jobs',
    handle: (context, deps) => routeResponder.result(() => deps.cronService.createJob(context.payload)),
  },
  {
    method: 'PUT',
    pattern: /^\/api\/cron\/jobs\/([^/]+)$/,
    handle: (context, deps, match) => routeResponder.result(() => deps.cronService.updateJob(
      decodeRouteParam(match.params[0]),
      context.payload,
    )),
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/cron\/jobs\/([^/]+)$/,
    handle: (_context, deps, match) => routeResponder.result(() => deps.cronService.deleteJob(
      decodeRouteParam(match.params[0]),
    )),
  },
  {
    method: 'POST',
    path: '/api/cron/toggle',
    handle: (context, deps) => routeResponder.result(() => deps.cronService.toggleJob(context.payload)),
  },
  {
    method: 'POST',
    path: '/api/cron/trigger',
    handle: (context, deps) => routeResponder.result(() => deps.cronService.trigger(context.payload)),
  },
] as const;

