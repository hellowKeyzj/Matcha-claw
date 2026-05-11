import { routeResponder, type RuntimeRouteDefinition } from './route-utils';

interface TeamRuntimeRouteService {
  init(payload: unknown): Promise<unknown>;
  snapshot(payload: unknown): Promise<unknown>;
  planUpsert(payload: unknown): Promise<unknown>;
  claimNext(payload: unknown): Promise<unknown>;
  heartbeat(payload: unknown): Promise<unknown>;
  taskUpdate(payload: unknown): Promise<unknown>;
  mailboxPost(payload: unknown): Promise<unknown>;
  mailboxPull(payload: unknown): Promise<unknown>;
  releaseClaim(payload: unknown): Promise<unknown>;
  reset(payload: unknown): Promise<unknown>;
  listTasks(payload: unknown): Promise<unknown>;
}

export const teamRuntimeRoutes: readonly RuntimeRouteDefinition<TeamRuntimeRouteService>[] = [
  { method: 'POST', path: '/api/team-runtime/init', handle: (context, service) => routeResponder.value(() => service.init(context.payload)) },
  { method: 'POST', path: '/api/team-runtime/snapshot', handle: (context, service) => routeResponder.value(() => service.snapshot(context.payload)) },
  { method: 'POST', path: '/api/team-runtime/plan-upsert', handle: (context, service) => routeResponder.value(() => service.planUpsert(context.payload)) },
  { method: 'POST', path: '/api/team-runtime/claim-next', handle: (context, service) => routeResponder.value(() => service.claimNext(context.payload)) },
  { method: 'POST', path: '/api/team-runtime/heartbeat', handle: (context, service) => routeResponder.value(() => service.heartbeat(context.payload)) },
  { method: 'POST', path: '/api/team-runtime/task-update', handle: (context, service) => routeResponder.value(() => service.taskUpdate(context.payload)) },
  { method: 'POST', path: '/api/team-runtime/mailbox-post', handle: (context, service) => routeResponder.value(() => service.mailboxPost(context.payload)) },
  { method: 'POST', path: '/api/team-runtime/mailbox-pull', handle: (context, service) => routeResponder.value(() => service.mailboxPull(context.payload)) },
  { method: 'POST', path: '/api/team-runtime/release-claim', handle: (context, service) => routeResponder.value(() => service.releaseClaim(context.payload)) },
  { method: 'POST', path: '/api/team-runtime/reset', handle: (context, service) => routeResponder.value(() => service.reset(context.payload)) },
  { method: 'POST', path: '/api/team-runtime/list-tasks', handle: (context, service) => routeResponder.value(() => service.listTasks(context.payload)) },
] as const;

