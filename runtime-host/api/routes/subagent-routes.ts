import { routeResponder, type ApplicationResponse, type RuntimeRouteDefinition } from './route-utils';

interface SubagentRouteService {
  listAgents(): Promise<ApplicationResponse>;
  getConfig(): Promise<ApplicationResponse>;
  getAgentFile(payload: unknown): Promise<ApplicationResponse>;
  listAgentFiles(payload: unknown): Promise<ApplicationResponse>;
}

interface SubagentRouteDeps {
  subagentService: SubagentRouteService;
}

export const subagentRoutes: readonly RuntimeRouteDefinition<SubagentRouteDeps>[] = [
  {
    method: 'POST',
    path: '/api/subagents/list',
    handle: (_context, deps) => routeResponder.result(() => deps.subagentService.listAgents()),
  },
  {
    method: 'POST',
    path: '/api/subagents/config/get',
    handle: (_context, deps) => routeResponder.result(() => deps.subagentService.getConfig()),
  },
  {
    method: 'POST',
    path: '/api/subagents/files/get',
    handle: (context, deps) => routeResponder.result(() => deps.subagentService.getAgentFile(context.payload)),
  },
  {
    method: 'POST',
    path: '/api/subagents/files/list',
    handle: (context, deps) => routeResponder.result(() => deps.subagentService.listAgentFiles(context.payload)),
  },
] as const;

