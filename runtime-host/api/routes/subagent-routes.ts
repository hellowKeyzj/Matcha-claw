import { routeResponder, type ApplicationResponse, type RuntimeRouteDefinition } from './route-utils';

interface SubagentRouteService {
  listAgents(): Promise<ApplicationResponse>;
  getConfig(): Promise<ApplicationResponse>;
  setConfig(payload: unknown): Promise<ApplicationResponse>;
  createAgent(payload: unknown): Promise<ApplicationResponse>;
  updateAgent(payload: unknown): Promise<ApplicationResponse>;
  deleteAgent(payload: unknown): Promise<ApplicationResponse>;
  getAgentFile(payload: unknown): Promise<ApplicationResponse>;
  setAgentFile(payload: unknown): Promise<ApplicationResponse>;
  listAgentFiles(payload: unknown): Promise<ApplicationResponse>;
  waitAgent(payload: unknown): Promise<ApplicationResponse>;
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
    path: '/api/subagents/config/set',
    handle: (context, deps) => routeResponder.result(() => deps.subagentService.setConfig(context.payload)),
  },
  {
    method: 'POST',
    path: '/api/subagents/create',
    handle: (context, deps) => routeResponder.result(() => deps.subagentService.createAgent(context.payload)),
  },
  {
    method: 'POST',
    path: '/api/subagents/update',
    handle: (context, deps) => routeResponder.result(() => deps.subagentService.updateAgent(context.payload)),
  },
  {
    method: 'POST',
    path: '/api/subagents/delete',
    handle: (context, deps) => routeResponder.result(() => deps.subagentService.deleteAgent(context.payload)),
  },
  {
    method: 'POST',
    path: '/api/subagents/files/get',
    handle: (context, deps) => routeResponder.result(() => deps.subagentService.getAgentFile(context.payload)),
  },
  {
    method: 'POST',
    path: '/api/subagents/files/set',
    handle: (context, deps) => routeResponder.result(() => deps.subagentService.setAgentFile(context.payload)),
  },
  {
    method: 'POST',
    path: '/api/subagents/files/list',
    handle: (context, deps) => routeResponder.result(() => deps.subagentService.listAgentFiles(context.payload)),
  },
  {
    method: 'POST',
    path: '/api/subagents/agent-wait',
    handle: (context, deps) => routeResponder.result(() => deps.subagentService.waitAgent(context.payload)),
  },
] as const;

