import { routeResponder, type ApplicationResponse, type RuntimeRouteDefinition } from './route-utils';

interface TaskRouteService {
  list(payload: unknown): Promise<ApplicationResponse>;
  get(payload: unknown): Promise<ApplicationResponse>;
  create(payload: unknown): Promise<ApplicationResponse>;
  update(payload: unknown): Promise<ApplicationResponse>;
  claim(payload: unknown): Promise<ApplicationResponse>;
}

type TaskRouteDeps = { taskService: TaskRouteService };

export const taskRoutes: readonly RuntimeRouteDefinition<TaskRouteDeps>[] = [
  {
    method: 'POST',
    path: '/api/tasks/list',
    handle: (context, deps) => routeResponder.result(() => deps.taskService.list(context.payload)),
  },
  {
    method: 'POST',
    path: '/api/tasks/get',
    handle: (context, deps) => routeResponder.result(() => deps.taskService.get(context.payload)),
  },
  {
    method: 'POST',
    path: '/api/tasks/create',
    handle: (context, deps) => routeResponder.result(() => deps.taskService.create(context.payload)),
  },
  {
    method: 'POST',
    path: '/api/tasks/update',
    handle: (context, deps) => routeResponder.result(() => deps.taskService.update(context.payload)),
  },
  {
    method: 'POST',
    path: '/api/tasks/claim',
    handle: (context, deps) => routeResponder.result(() => deps.taskService.claim(context.payload)),
  },
] as const;
