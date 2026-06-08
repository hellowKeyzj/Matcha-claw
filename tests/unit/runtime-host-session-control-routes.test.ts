import { describe, expect, it, vi } from 'vitest';
import { sessionRoutes } from '../../runtime-host/api/routes/session-routes';
import type { RuntimeEndpointRef, SessionIdentity } from '../../runtime-host/application/agent-runtime/contracts/runtime-address';
import { dispatchRuntimeRouteDefinition } from './helpers/runtime-route';

const endpoint: RuntimeEndpointRef = {
  kind: 'native-runtime',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'openclaw-local',
};

const sessionIdentity: SessionIdentity = {
  endpoint,
  agentId: 'default',
  sessionKey: 'session-1',
};

const allowedRouteCases = [
  ['/api/sessions/list', 'listSessions'],
  ['/api/sessions/approvals', 'listPendingApprovals'],
] as const;

const hydratingRejectedRouteCases = [
  ['/api/sessions/window', 'getSessionWindow'],
  ['/api/sessions/state', 'getSessionStateSnapshot'],
] as const;

const rejectedRouteCases = [
  ['/api/sessions/create', 'createSession'],
  ['/api/sessions/load', 'loadSession'],
  ['/api/sessions/prompt', 'promptSession'],
  ['/api/sessions/patch', 'patchSession'],
  ['/api/sessions/rename', 'renameSession'],
  ['/api/sessions/delete', 'deleteSession'],
  ['/api/sessions/archive', 'archiveSession'],
  ['/api/sessions/unarchive', 'unarchiveSession'],
  ['/api/sessions/status', 'updateSessionStatus'],
  ['/api/sessions/switch', 'switchSession'],
  ['/api/sessions/resume', 'resumeSession'],
  ['/api/sessions/abort', 'abortSession'],
  ['/api/sessions/approval/resolve', 'resolveApproval'],
] as const;

const routeCases = [...allowedRouteCases, ...hydratingRejectedRouteCases, ...rejectedRouteCases] as const;

type SessionRouteMethod = typeof routeCases[number][1];

function createSessionService() {
  return Object.fromEntries(routeCases.map(([, method]) => [method, vi.fn(async (payload) => ({ success: true, payload }))])) as Record<SessionRouteMethod, ReturnType<typeof vi.fn>>;
}

function createPayload(method: SessionRouteMethod) {
  switch (method) {
    case 'listSessions':
      return { endpoint };
    case 'createSession':
      return { sessionKey: sessionIdentity.sessionKey, endpoint, agentId: sessionIdentity.agentId };
    case 'getSessionWindow':
      return { sessionKey: sessionIdentity.sessionKey, sessionIdentity, mode: 'latest' };
    case 'promptSession':
      return { sessionKey: sessionIdentity.sessionKey, sessionIdentity, message: 'hello' };
    case 'patchSession':
      return { sessionKey: sessionIdentity.sessionKey, sessionIdentity, runtimeModelRef: 'model-1' };
    case 'renameSession':
      return { sessionKey: sessionIdentity.sessionKey, sessionIdentity, label: 'Renamed session' };
    case 'updateSessionStatus':
      return { sessionKey: sessionIdentity.sessionKey, sessionIdentity, status: 'completed' };
    case 'listPendingApprovals':
      return { sessionIdentity };
    case 'resolveApproval':
      return { sessionKey: sessionIdentity.sessionKey, sessionIdentity, id: 'approval-1', decision: 'allow-once' };
    default:
      return { sessionKey: sessionIdentity.sessionKey, sessionIdentity };
  }
}

describe('runtime-host session routes', () => {
  it.each(allowedRouteCases)('routes allowlisted POST %s to %s with the explicit payload', async (path, method) => {
    const service = createSessionService();
    const payload = createPayload(method);

    const response = await dispatchRuntimeRouteDefinition(sessionRoutes, 'POST', path, payload, service);

    expect(response).toEqual({ status: 200, data: { success: true, payload } });
    expect(service[method]).toHaveBeenCalledWith(payload);
  });

  it.each(hydratingRejectedRouteCases)('rejects hydrating legacy POST %s without dispatching %s', async (path, method) => {
    const service = createSessionService();
    const payload = createPayload(method);

    const response = await dispatchRuntimeRouteDefinition(sessionRoutes, 'POST', path, payload, service);

    expect(response).toEqual({
      status: 400,
      data: {
        success: false,
        error: 'Legacy session route may hydrate session state; use /api/capabilities/execute with a session target',
      },
    });
    expect(service[method]).not.toHaveBeenCalled();
  });

  it.each(rejectedRouteCases)('rejects legacy POST %s without dispatching %s', async (path, method) => {
    const service = createSessionService();
    const payload = createPayload(method);

    const response = await dispatchRuntimeRouteDefinition(sessionRoutes, 'POST', path, payload, service);

    expect(response).toMatchObject({ status: 400, data: { success: false } });
    expect(service[method]).not.toHaveBeenCalled();
  });

  it.each([
    ['/api/sessions/list', 'listSessions', {}, 'RuntimeEndpointRef is required'],
    ['/api/sessions/approvals', 'listPendingApprovals', {}, 'SessionIdentity is required'],
  ] as const)('validates legacy read-only DTO before dispatching POST %s', async (path, method, payload, error) => {
    const service = createSessionService();

    const response = await dispatchRuntimeRouteDefinition(sessionRoutes, 'POST', path, payload, service);

    expect(response).toEqual({ status: 400, data: { success: false, error } });
    expect(service[method]).not.toHaveBeenCalled();
  });

  it('does not expose session operations through GET', async () => {
    const service = createSessionService();

    const response = await dispatchRuntimeRouteDefinition(sessionRoutes, 'GET', '/api/sessions/list', undefined, service);

    expect(response).toBeNull();
    expect(service.listSessions).not.toHaveBeenCalled();
  });
});
