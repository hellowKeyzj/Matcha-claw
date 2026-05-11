import { routeResponder, type ApplicationResponse, type RuntimeRouteDefinition } from './route-utils';

interface SessionRouteService {
  listSessions: () => Promise<ApplicationResponse>;
  getSessionWindow: (payload: unknown) => Promise<ApplicationResponse>;
  createSession: (payload: unknown) => Promise<ApplicationResponse>;
  loadSession: (payload: unknown) => Promise<ApplicationResponse>;
  promptSession: (payload: unknown) => Promise<ApplicationResponse>;
  patchSession: (payload: unknown) => Promise<ApplicationResponse>;
  deleteSession: (payload: unknown) => Promise<ApplicationResponse>;
  switchSession: (payload: unknown) => Promise<ApplicationResponse>;
  resumeSession: (payload: unknown) => Promise<ApplicationResponse>;
  getSessionStateSnapshot: (payload: unknown) => Promise<ApplicationResponse>;
  abortSessionRuntime: (payload: unknown) => Promise<ApplicationResponse>;
  abortSession: (payload: unknown) => Promise<ApplicationResponse>;
  listPendingApprovals: () => Promise<ApplicationResponse>;
  resolveApproval: (payload: unknown) => Promise<ApplicationResponse>;
}

export const sessionRoutes: readonly RuntimeRouteDefinition<SessionRouteService>[] = [
  { method: 'GET', path: '/api/sessions/list', handle: (_context, service) => routeResponder.result(() => service.listSessions()) },
  { method: 'POST', path: '/api/sessions/window', handle: (context, service) => routeResponder.result(() => service.getSessionWindow(context.payload)) },
  { method: 'POST', path: '/api/session/new', handle: (context, service) => routeResponder.result(() => service.createSession(context.payload)) },
  { method: 'POST', path: '/api/session/load', handle: (context, service) => routeResponder.result(() => service.loadSession(context.payload)) },
  { method: 'POST', path: '/api/session/prompt', handle: (context, service) => routeResponder.result(() => service.promptSession(context.payload)) },
  { method: 'POST', path: '/api/session/patch', handle: (context, service) => routeResponder.result(() => service.patchSession(context.payload)) },
  { method: 'POST', path: '/api/sessions/delete', handle: (context, service) => routeResponder.result(() => service.deleteSession(context.payload)) },
  { method: 'POST', path: '/api/session/switch', handle: (context, service) => routeResponder.result(() => service.switchSession(context.payload)) },
  { method: 'POST', path: '/api/session/resume', handle: (context, service) => routeResponder.result(() => service.resumeSession(context.payload)) },
  { method: 'POST', path: '/api/session/state', handle: (context, service) => routeResponder.result(() => service.getSessionStateSnapshot(context.payload)) },
  { method: 'POST', path: '/api/session/abort-runtime', handle: (context, service) => routeResponder.result(() => service.abortSessionRuntime(context.payload)) },
  { method: 'POST', path: '/api/session/abort', handle: (context, service) => routeResponder.result(() => service.abortSession(context.payload)) },
  { method: 'GET', path: '/api/session/approvals', handle: (_context, service) => routeResponder.result(() => service.listPendingApprovals()) },
  { method: 'POST', path: '/api/session/approval/resolve', handle: (context, service) => routeResponder.result(() => service.resolveApproval(context.payload)) },
] as const;

