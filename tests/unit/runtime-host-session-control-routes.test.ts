import { describe, expect, it, vi } from 'vitest';
import { sessionRoutes } from '../../runtime-host/api/routes/session-routes';
import { dispatchRuntimeRouteDefinition } from './helpers/runtime-route';

function createSessionService() {
  return {
    listSessions: vi.fn(),
    getSessionWindow: vi.fn(),
    createSession: vi.fn(),
    loadSession: vi.fn(),
    promptSession: vi.fn(),
    patchSession: vi.fn(),
    deleteSession: vi.fn(),
    switchSession: vi.fn(),
    resumeSession: vi.fn(),
    getSessionStateSnapshot: vi.fn(),
    abortSessionRuntime: vi.fn(),
    abortSession: vi.fn(async () => ({
      status: 200,
      data: { success: true, snapshot: { sessionKey: 'agent:main:main' } },
    })),
    listPendingApprovals: vi.fn(async () => ({
      status: 200,
      data: { approvals: [] },
    })),
    resolveApproval: vi.fn(async () => ({
      status: 200,
      data: { success: true },
    })),
  };
}

describe('runtime-host session control routes', () => {
  it('routes session abort through injected session service', async () => {
    const service = createSessionService();
    const payload = {
      sessionKey: 'agent:main:main',
      approvalIds: ['approval-1'],
    };

    const response = await dispatchRuntimeRouteDefinition(sessionRoutes, 'POST', '/api/session/abort', payload, service);

    expect(service.abortSession).toHaveBeenCalledWith(payload);
    expect(response).toEqual({
      status: 200,
      data: { success: true, snapshot: { sessionKey: 'agent:main:main' } },
    });
  });

  it('routes approval list and resolve through injected session service', async () => {
    const service = createSessionService();

    await expect(dispatchRuntimeRouteDefinition(sessionRoutes, 'GET', '/api/session/approvals', undefined, service))
      .resolves.toEqual({ status: 200, data: { approvals: [] } });
    await expect(dispatchRuntimeRouteDefinition(sessionRoutes, 
      'POST',
      '/api/session/approval/resolve',
      { id: 'approval-1', decision: 'allow' },
      service,
    )).resolves.toEqual({ status: 200, data: { success: true } });

    expect(service.listPendingApprovals).toHaveBeenCalledTimes(1);
    expect(service.resolveApproval).toHaveBeenCalledWith({ id: 'approval-1', decision: 'allow' });
  });
});
