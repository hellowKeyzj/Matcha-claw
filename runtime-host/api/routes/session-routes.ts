import { routeResponder, type RuntimeRouteDefinition } from './route-utils';

interface SessionRouteService {
  createSession: (payload: unknown) => Promise<unknown>;
  deleteSession: (payload: unknown) => Promise<unknown>;
  archiveSession: (payload: unknown) => Promise<unknown>;
  unarchiveSession: (payload: unknown) => Promise<unknown>;
  updateSessionStatus: (payload: unknown) => Promise<unknown>;
  listSessions: (payload: unknown) => Promise<unknown>;
  loadSession: (payload: unknown) => Promise<unknown>;
  resumeSession: (payload: unknown) => Promise<unknown>;
  patchSession: (payload: unknown) => Promise<unknown>;
  renameSession: (payload: unknown) => Promise<unknown>;
  switchSession: (payload: unknown) => Promise<unknown>;
  getSessionStateSnapshot: (payload: unknown) => Promise<unknown>;
  getSessionWindow: (payload: unknown) => Promise<unknown>;
  abortSession: (payload: unknown) => Promise<unknown>;
  listPendingApprovals: (payload: unknown) => Promise<unknown>;
  resolveApproval: (payload: unknown) => Promise<unknown>;
  promptSession: (payload: unknown) => Promise<unknown>;
}

type SessionRouteOperation = (service: SessionRouteService, payload: unknown) => Promise<unknown>;

function sessionRoute(path: string, operation: SessionRouteOperation): RuntimeRouteDefinition<SessionRouteService> {
  return {
    method: 'POST',
    path,
    handle: (context, service) => routeResponder.result(() => operation(service, context.payload), (message) => ({ success: false, error: message })),
  };
}

export const sessionRoutes: readonly RuntimeRouteDefinition<SessionRouteService>[] = [
  sessionRoute('/api/sessions/list', (service, payload) => service.listSessions(payload)),
  sessionRoute('/api/sessions/create', (service, payload) => service.createSession(payload)),
  sessionRoute('/api/sessions/load', (service, payload) => service.loadSession(payload)),
  sessionRoute('/api/sessions/window', (service, payload) => service.getSessionWindow(payload)),
  sessionRoute('/api/sessions/prompt', (service, payload) => service.promptSession(payload)),
  sessionRoute('/api/sessions/patch', (service, payload) => service.patchSession(payload)),
  sessionRoute('/api/sessions/rename', (service, payload) => service.renameSession(payload)),
  sessionRoute('/api/sessions/delete', (service, payload) => service.deleteSession(payload)),
  sessionRoute('/api/sessions/archive', (service, payload) => service.archiveSession(payload)),
  sessionRoute('/api/sessions/unarchive', (service, payload) => service.unarchiveSession(payload)),
  sessionRoute('/api/sessions/status', (service, payload) => service.updateSessionStatus(payload)),
  sessionRoute('/api/sessions/switch', (service, payload) => service.switchSession(payload)),
  sessionRoute('/api/sessions/resume', (service, payload) => service.resumeSession(payload)),
  sessionRoute('/api/sessions/state', (service, payload) => service.getSessionStateSnapshot(payload)),
  sessionRoute('/api/sessions/abort', (service, payload) => service.abortSession(payload)),
  sessionRoute('/api/sessions/approvals', (service, payload) => service.listPendingApprovals(payload)),
  sessionRoute('/api/sessions/approval/resolve', (service, payload) => service.resolveApproval(payload)),
] as const;
