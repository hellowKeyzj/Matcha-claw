import {
  readSessionIdentityRequest,
  readSessionListRequest,
  readSessionLoadRequest,
  readSessionWindowRequest,
} from '../../application/sessions/session-runtime-requests';
import {
  badRequest,
  routeResponder,
  sanitizeReadOnlyRouteResponse,
  type RuntimeRouteDefinition,
} from './route-utils';

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

type LegacyReadOnlySessionRoute = '/api/sessions/list'
  | '/api/sessions/window'
  | '/api/sessions/state'
  | '/api/sessions/approvals';

const LEGACY_SESSION_ROUTE_REJECTION = 'Legacy session route is disabled; use /api/capabilities/execute with a capability target';
const LEGACY_HYDRATING_SESSION_ROUTE_REJECTION = 'Legacy session route may hydrate session state; use /api/capabilities/execute with a session target';

const LEGACY_READ_ONLY_SESSION_ROUTES = new Set<LegacyReadOnlySessionRoute>([
  '/api/sessions/list',
  '/api/sessions/window',
  '/api/sessions/state',
  '/api/sessions/approvals',
]);

function validateLegacyReadOnlySessionPayload(path: LegacyReadOnlySessionRoute, payload: unknown): string | null {
  switch (path) {
    case '/api/sessions/list': {
      const { endpoint, endpointError } = readSessionListRequest(payload);
      return endpointError || !endpoint ? endpointError ?? 'RuntimeEndpointRef is required' : null;
    }
    case '/api/sessions/window': {
      const {
        sessionKey,
        sessionIdentity,
        sessionIdentityError,
        mode,
        offset,
      } = readSessionWindowRequest(payload);
      if (!sessionKey) {
        return 'sessionKey is required';
      }
      if (sessionIdentityError || !sessionIdentity) {
        return sessionIdentityError ?? 'SessionIdentity is required';
      }
      if ((mode === 'older' || mode === 'newer') && offset == null) {
        return `offset is required for mode: ${mode}`;
      }
      return null;
    }
    case '/api/sessions/state': {
      const { sessionKey, sessionIdentity, sessionIdentityError } = readSessionLoadRequest(payload);
      if (!sessionKey) {
        return 'sessionKey is required';
      }
      return sessionIdentityError || !sessionIdentity ? sessionIdentityError ?? 'SessionIdentity is required' : null;
    }
    case '/api/sessions/approvals': {
      const { sessionIdentity, sessionIdentityError } = readSessionIdentityRequest(payload);
      return sessionIdentityError || !sessionIdentity ? sessionIdentityError ?? 'SessionIdentity is required' : null;
    }
  }
}

function rejectedHydratingSessionRoute(path: LegacyReadOnlySessionRoute): RuntimeRouteDefinition<SessionRouteService> {
  if (!LEGACY_READ_ONLY_SESSION_ROUTES.has(path)) {
    throw new Error(`Legacy hydrating session route is not allowlisted: ${path}`);
  }
  return {
    method: 'POST',
    path,
    handle: () => badRequest(LEGACY_HYDRATING_SESSION_ROUTE_REJECTION),
  };
}

function sessionReadOnlyRoute(path: LegacyReadOnlySessionRoute, operation: SessionRouteOperation): RuntimeRouteDefinition<SessionRouteService> {
  if (!LEGACY_READ_ONLY_SESSION_ROUTES.has(path)) {
    throw new Error(`Legacy read-only session route is not allowlisted: ${path}`);
  }
  return {
    method: 'POST',
    path,
    handle: (context, service) => routeResponder.result(async () => {
      const validationError = validateLegacyReadOnlySessionPayload(path, context.payload);
      if (validationError) {
        return badRequest(validationError);
      }
      return sanitizeReadOnlyRouteResponse(await operation(service, context.payload));
    }, (message) => ({ success: false, error: message })),
  };
}

function rejectedSessionRoute(path: string): RuntimeRouteDefinition<SessionRouteService> {
  return {
    method: 'POST',
    path,
    handle: () => badRequest(LEGACY_SESSION_ROUTE_REJECTION),
  };
}

export const sessionRoutes: readonly RuntimeRouteDefinition<SessionRouteService>[] = [
  sessionReadOnlyRoute('/api/sessions/list', (service, payload) => service.listSessions(payload)),
  rejectedHydratingSessionRoute('/api/sessions/window'),
  rejectedHydratingSessionRoute('/api/sessions/state'),
  sessionReadOnlyRoute('/api/sessions/approvals', (service, payload) => service.listPendingApprovals(payload)),
  rejectedSessionRoute('/api/sessions/create'),
  rejectedSessionRoute('/api/sessions/load'),
  rejectedSessionRoute('/api/sessions/prompt'),
  rejectedSessionRoute('/api/sessions/patch'),
  rejectedSessionRoute('/api/sessions/rename'),
  rejectedSessionRoute('/api/sessions/delete'),
  rejectedSessionRoute('/api/sessions/archive'),
  rejectedSessionRoute('/api/sessions/unarchive'),
  rejectedSessionRoute('/api/sessions/status'),
  rejectedSessionRoute('/api/sessions/switch'),
  rejectedSessionRoute('/api/sessions/resume'),
  rejectedSessionRoute('/api/sessions/abort'),
  rejectedSessionRoute('/api/sessions/approval/resolve'),
] as const;
