import { describe, expect, it, vi } from 'vitest';
import { sessionRoutes } from '../../runtime-host/api/routes/session-routes';
import { dispatchRuntimeRouteDefinition } from './helpers/runtime-route';

const runtimeAddress = {
  kind: 'native-runtime',
  capabilityId: 'session.prompt',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'openclaw-local',
  agentId: 'default',
};

const routeCases = [
  ['/api/sessions/list', 'listSessions'],
  ['/api/sessions/create', 'createSession'],
  ['/api/sessions/load', 'loadSession'],
  ['/api/sessions/window', 'getSessionWindow'],
  ['/api/sessions/prompt', 'promptSession'],
  ['/api/sessions/patch', 'patchSession'],
  ['/api/sessions/rename', 'renameSession'],
  ['/api/sessions/delete', 'deleteSession'],
  ['/api/sessions/archive', 'archiveSession'],
  ['/api/sessions/unarchive', 'unarchiveSession'],
  ['/api/sessions/status', 'updateSessionStatus'],
  ['/api/sessions/switch', 'switchSession'],
  ['/api/sessions/resume', 'resumeSession'],
  ['/api/sessions/state', 'getSessionStateSnapshot'],
  ['/api/sessions/abort', 'abortSession'],
  ['/api/sessions/approvals', 'listPendingApprovals'],
  ['/api/sessions/approval/resolve', 'resolveApproval'],
] as const;

type SessionRouteMethod = typeof routeCases[number][1];

function createSessionService() {
  return Object.fromEntries(routeCases.map(([, method]) => [method, vi.fn(async (payload) => ({ success: true, payload }))])) as Record<SessionRouteMethod, ReturnType<typeof vi.fn>>;
}

function createValidatingSessionService() {
  const service = createSessionService();
  for (const method of ['createSession', 'loadSession', 'getSessionWindow', 'promptSession', 'abortSession', 'listPendingApprovals', 'resolveApproval'] as const) {
    service[method].mockImplementation(async (payload: unknown) => {
      const body = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : {};
      if (!body.runtimeAddress) {
        return { status: 400, data: { success: false, error: 'RuntimeAddress is required' } };
      }
      return { status: 200, data: { success: true, payload } };
    });
  }
  return service;
}

describe('runtime-host session routes', () => {
  it.each(routeCases)('routes POST %s to %s with the explicit payload', async (path, method) => {
    const service = createSessionService();
    const payload = { sessionKey: 'session-1', runtimeAddress };

    const response = await dispatchRuntimeRouteDefinition(sessionRoutes, 'POST', path, payload, service);

    expect(response).toEqual({ status: 200, data: { success: true, payload } });
    expect(service[method]).toHaveBeenCalledWith(payload);
  });

  it.each([
    ['/api/sessions/create', 'createSession', { sessionKey: 'session-1' }],
    ['/api/sessions/load', 'loadSession', { sessionKey: 'session-1' }],
    ['/api/sessions/window', 'getSessionWindow', { sessionKey: 'session-1', mode: 'latest' }],
    ['/api/sessions/prompt', 'promptSession', { sessionKey: 'session-1', message: 'hello' }],
    ['/api/sessions/abort', 'abortSession', { sessionKey: 'session-1' }],
    ['/api/sessions/approvals', 'listPendingApprovals', {}],
    ['/api/sessions/approval/resolve', 'resolveApproval', { sessionKey: 'session-1', id: 'approval-1', decision: 'allow-once' }],
  ] as const)('returns explicit RuntimeAddress errors for POST %s', async (path, method, payload) => {
    const service = createValidatingSessionService();

    const response = await dispatchRuntimeRouteDefinition(sessionRoutes, 'POST', path, payload, service);

    expect(response).toEqual({ status: 400, data: { success: false, error: 'RuntimeAddress is required' } });
    expect(service[method]).toHaveBeenCalledWith(payload);
  });

  it('does not expose session operations through GET', async () => {
    const service = createSessionService();

    const response = await dispatchRuntimeRouteDefinition(sessionRoutes, 'GET', '/api/sessions/list', undefined, service);

    expect(response).toBeNull();
    expect(service.listSessions).not.toHaveBeenCalled();
  });
});
