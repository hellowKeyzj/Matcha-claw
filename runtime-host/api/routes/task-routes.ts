import { routeResponder, type ApplicationResponse, type RuntimeRouteDefinition } from './route-utils';

interface TaskRouteService {
  list(payload: unknown): Promise<ApplicationResponse>;
  get(payload: unknown): Promise<ApplicationResponse>;
  create(payload: unknown): Promise<ApplicationResponse>;
  update(payload: unknown): Promise<ApplicationResponse>;
  todoWrite(payload: unknown): Promise<ApplicationResponse>;
  todoGet(payload: unknown): Promise<ApplicationResponse>;
  output(payload: unknown): Promise<ApplicationResponse>;
  stop(payload: unknown): Promise<ApplicationResponse>;
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
    path: '/api/tasks/todos/write',
    handle: (context, deps) => routeResponder.result(() => deps.taskService.todoWrite(context.payload)),
  },
  {
    method: 'POST',
    path: '/api/tasks/todos/get',
    handle: (context, deps) => routeResponder.result(() => deps.taskService.todoGet(context.payload)),
  },
  {
    method: 'POST',
    path: '/api/tasks/output',
    handle: (context, deps) => routeResponder.result(() => deps.taskService.output(context.payload)),
  },
  {
    method: 'POST',
    path: '/api/tasks/stop',
    handle: (context, deps) => routeResponder.result(() => deps.taskService.stop(context.payload)),
  },
] as const;
