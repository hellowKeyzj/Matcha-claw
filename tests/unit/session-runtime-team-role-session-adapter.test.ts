import { describe, expect, it, vi } from 'vitest';
import { SessionRuntimeTeamRoleSessionAdapter } from '../../runtime-host/application/team-runtime/adapters/session-runtime-team-role-session-adapter';
import type { TeamRoleSessionBinding } from '../../runtime-host/application/team-runtime/domain/team-run';
import { createOpenClawTestSessionIdentity, openClawTestRuntimeEndpoint } from './helpers/runtime-address-fixtures';

function createAdapter() {
  const calls = {
    createSession: vi.fn(async () => ({ status: 200, data: { success: true } })),
    promptSession: vi.fn(async (payload: unknown) => ({
      status: 200,
      data: {
        success: true,
        localSessionId: (payload as { sessionKey: string }).sessionKey,
        runId: 'prompt-run-1',
        item: null,
        snapshot: { items: [] },
      },
    })),
    abortSession: vi.fn(async () => ({ status: 200, data: { success: true } })),
    deleteSession: vi.fn(async () => ({ status: 200, data: { success: true } })),
    getSessionWindow: vi.fn(async () => ({
      status: 200,
      data: {
        snapshot: {
          items: [{ kind: 'user-message', text: 'hello' }],
        },
      },
    })),
    agentRuntimeRegistry: {
      rememberSessionIdentity: vi.fn(),
      forgetSessionContext: vi.fn(),
    },
    endpointSessionMaterialization: {
      resolveEndpointSessionId: vi.fn((binding: TeamRoleSessionBinding) => binding.endpointSessionId),
      materializeEndpointSession: vi.fn(async () => undefined),
      dematerializeEndpointSession: vi.fn(async () => undefined),
    },
  };
  return {
    calls,
    adapter: new SessionRuntimeTeamRoleSessionAdapter(calls),
  };
}

describe('SessionRuntimeTeamRoleSessionAdapter', () => {
  it('ensures and prompts a Team role through the same SessionIdentity without spawn fields', async () => {
    const { adapter, calls } = createAdapter();
    const localSessionId = 'local:team-run:run-1:role:reviewer';
    const endpointSessionId = 'endpoint-session-run-1-reviewer';
    const sessionIdentity = createOpenClawTestSessionIdentity(localSessionId, 'reviewer');

    const binding = await adapter.ensureRoleSession({
      runId: 'run-1',
      roleId: 'reviewer',
      agentId: 'reviewer',
      endpointRef: openClawTestRuntimeEndpoint,
      localSessionId,
      endpointSessionId,
      sessionIdentity,
    });
    const result = await adapter.promptRoleSession({
      binding,
      message: 'Review the plan',
      idempotencyKey: 'prompt-run-1',
      deliver: false,
    });

    expect(binding).toEqual({
      runId: 'run-1',
      roleId: 'reviewer',
      agentId: 'reviewer',
      endpointRef: openClawTestRuntimeEndpoint,
      localSessionId,
      endpointSessionId,
      sessionIdentity,
    });
    expect(calls.endpointSessionMaterialization.resolveEndpointSessionId).toHaveBeenCalledWith(binding);
    expect(calls.createSession).toHaveBeenCalledWith({
      sessionKey: localSessionId,
      endpoint: openClawTestRuntimeEndpoint,
      agentId: 'reviewer',
      endpointSessionId,
    });
    expect(calls.endpointSessionMaterialization.materializeEndpointSession).toHaveBeenCalledWith(binding);
    expect(calls.agentRuntimeRegistry.rememberSessionIdentity).toHaveBeenCalledWith(sessionIdentity, endpointSessionId);
    expect(calls.promptSession).toHaveBeenCalledWith({
      sessionKey: localSessionId,
      endpointSessionId,
      sessionIdentity,
      message: 'Review the plan',
      idempotencyKey: 'prompt-run-1',
      deliver: false,
    });
    expect(calls.promptSession.mock.calls[0][0]).not.toHaveProperty('runId');
    expect(JSON.stringify(calls.createSession.mock.calls)).not.toContain('sessions_spawn');
    expect(JSON.stringify(calls.promptSession.mock.calls)).not.toContain('sessions_spawn');
    expect(calls.promptSession.mock.calls[0][0]).not.toHaveProperty('spawn');
    expect(result).toEqual({
      runId: 'run-1',
      roleId: 'reviewer',
      localSessionId,
      promptRunId: 'prompt-run-1',
    });
  });

  it('passes the adapter-resolved endpoint session id to SessionRuntime while keeping the Team binding opaque', async () => {
    const { adapter, calls } = createAdapter();
    const localSessionId = 'team-role-session-run-1-reviewer';
    const endpointSessionId = 'team-endpoint-session-run-1-reviewer';
    const gatewaySessionKey = 'agent:reviewer:team-endpoint-session-run-1-reviewer';
    const sessionIdentity = createOpenClawTestSessionIdentity(localSessionId, 'reviewer');
    calls.endpointSessionMaterialization.resolveEndpointSessionId.mockReturnValue(gatewaySessionKey);

    const binding = await adapter.ensureRoleSession({
      runId: 'run-1',
      roleId: 'reviewer',
      agentId: 'reviewer',
      endpointRef: openClawTestRuntimeEndpoint,
      localSessionId,
      endpointSessionId,
      sessionIdentity,
    });

    expect(binding.endpointSessionId).toBe(endpointSessionId);
    expect(calls.createSession).toHaveBeenCalledWith({
      sessionKey: localSessionId,
      endpoint: openClawTestRuntimeEndpoint,
      agentId: 'reviewer',
      endpointSessionId: gatewaySessionKey,
    });
    expect(calls.agentRuntimeRegistry.rememberSessionIdentity).toHaveBeenCalledWith(sessionIdentity, gatewaySessionKey);

    await adapter.promptRoleSession({
      binding,
      message: 'Review the plan',
      idempotencyKey: 'prompt-run-1',
    });
    expect(calls.promptSession).toHaveBeenCalledWith({
      sessionKey: localSessionId,
      endpointSessionId: gatewaySessionKey,
      sessionIdentity,
      message: 'Review the plan',
      idempotencyKey: 'prompt-run-1',
    });

    await adapter.abortRoleSession({
      binding,
      runId: 'prompt-run-1',
    });
    expect(calls.abortSession).toHaveBeenCalledWith({
      sessionKey: localSessionId,
      endpointSessionId: gatewaySessionKey,
      sessionIdentity,
      runId: 'prompt-run-1',
    });
  });

  it('passes displayMessage separately from the delivered TeamRun prompt', async () => {
    const { adapter, calls } = createAdapter();
    const localSessionId = 'local:team-run:run-1:role:leader';
    const endpointSessionId = 'endpoint-session-run-1-leader';
    const sessionIdentity = createOpenClawTestSessionIdentity(localSessionId, 'mct-team');

    await adapter.promptRoleSession({
      binding: {
        runId: 'run-1',
        roleId: 'leader',
        agentId: 'mct-team',
        endpointRef: openClawTestRuntimeEndpoint,
        localSessionId,
        endpointSessionId,
        sessionIdentity,
      },
      message: '## TeamRun WorkNode\nfull prompt',
      displayMessage: '用户原文',
      idempotencyKey: 'prompt-run-1',
    });

    expect(calls.promptSession).toHaveBeenCalledWith({
      sessionKey: localSessionId,
      endpointSessionId,
      sessionIdentity,
      message: '## TeamRun WorkNode\nfull prompt',
      displayMessage: '用户原文',
      idempotencyKey: 'prompt-run-1',
    });
  });

  it('fails ensure when endpoint session materialization fails after Matcha session creation', async () => {
    const { adapter, calls } = createAdapter();
    const localSessionId = 'local:team-run:run-1:role:reviewer';
    const endpointSessionId = 'endpoint-session-run-1-reviewer';
    const sessionIdentity = createOpenClawTestSessionIdentity(localSessionId, 'mct-team');
    calls.endpointSessionMaterialization.materializeEndpointSession.mockRejectedValueOnce(new Error('sessions.create failed'));

    await expect(adapter.ensureRoleSession({
      runId: 'run-1',
      roleId: 'reviewer',
      agentId: 'mct-team',
      endpointRef: openClawTestRuntimeEndpoint,
      localSessionId,
      endpointSessionId,
      sessionIdentity,
    })).rejects.toThrow('sessions.create failed');
    expect(calls.createSession).toHaveBeenCalledWith({
      sessionKey: localSessionId,
      endpoint: openClawTestRuntimeEndpoint,
      agentId: 'mct-team',
      endpointSessionId,
    });
    expect(calls.endpointSessionMaterialization.materializeEndpointSession).toHaveBeenCalledWith({
      runId: 'run-1',
      roleId: 'reviewer',
      agentId: 'mct-team',
      endpointRef: openClawTestRuntimeEndpoint,
      localSessionId,
      endpointSessionId,
      sessionIdentity,
    });
  });

  it('rejects a binding when the requested agentId differs from SessionIdentity.agentId', async () => {
    const { adapter, calls } = createAdapter();
    const localSessionId = 'local:team-run:run-1:role:reviewer';
    const sessionIdentity = createOpenClawTestSessionIdentity(localSessionId, 'reviewer');

    await expect(adapter.ensureRoleSession({
      runId: 'run-1',
      roleId: 'reviewer',
      agentId: 'writer',
      endpointRef: openClawTestRuntimeEndpoint,
      localSessionId,
      endpointSessionId: 'endpoint-session-run-1-reviewer',
      sessionIdentity,
    })).rejects.toThrow('Team role agentId writer must match SessionIdentity.agentId reviewer.');
    expect(calls.createSession).not.toHaveBeenCalled();
  });

  it('returns a hydrating read window as an actionable pending result', async () => {
    const { adapter, calls } = createAdapter();
    const localSessionId = 'local:team-run:run-1:role:reviewer';
    const endpointSessionId = 'endpoint-session-run-1-reviewer';
    const sessionIdentity = createOpenClawTestSessionIdentity(localSessionId, 'reviewer');
    calls.getSessionWindow.mockResolvedValueOnce({
      status: 202,
      data: { hydrationJob: { id: 'hydrate-1', status: 'queued' } },
    });

    const result = await adapter.readRoleSessionWindow({
      binding: {
        runId: 'run-1',
        roleId: 'reviewer',
        agentId: 'reviewer',
        endpointRef: openClawTestRuntimeEndpoint,
        localSessionId,
        endpointSessionId,
        sessionIdentity,
      },
      limit: 20,
    });

    expect(calls.getSessionWindow).toHaveBeenCalledWith({
      sessionKey: localSessionId,
      endpointSessionId,
      sessionIdentity,
      limit: 20,
    });
    expect(result).toEqual({
      resultType: 'pending_hydration',
      localSessionId,
      message: 'Session window for Team role reviewer is hydrating. Retry readRoleSessionWindow after the queued hydration job completes.',
    });
  });

  it('deletes through the existing session runtime service with the role SessionIdentity', async () => {
    const { adapter, calls } = createAdapter();
    const localSessionId = 'local:team-run:run-1:role:reviewer';
    const endpointSessionId = 'endpoint-session-run-1-reviewer';
    const sessionIdentity = createOpenClawTestSessionIdentity(localSessionId, 'reviewer');

    await adapter.deleteRoleSession({
      binding: {
        runId: 'run-1',
        roleId: 'reviewer',
        agentId: 'reviewer',
        endpointRef: openClawTestRuntimeEndpoint,
        localSessionId,
        endpointSessionId,
        sessionIdentity,
      },
    });

    expect(calls.deleteSession).toHaveBeenCalledWith({
      sessionKey: localSessionId,
      sessionIdentity,
    });
    expect(calls.endpointSessionMaterialization.dematerializeEndpointSession).toHaveBeenCalledWith({
      runId: 'run-1',
      roleId: 'reviewer',
      agentId: 'reviewer',
      endpointRef: openClawTestRuntimeEndpoint,
      localSessionId,
      endpointSessionId,
      sessionIdentity,
    });
    expect(calls.agentRuntimeRegistry.forgetSessionContext).toHaveBeenCalledWith(sessionIdentity);
  });

  it('treats an already-missing role session as deleted', async () => {
    const { adapter, calls } = createAdapter();
    const localSessionId = 'local:team-run:run-1:role:reviewer';
    const endpointSessionId = 'endpoint-session-run-1-reviewer';
    const sessionIdentity = createOpenClawTestSessionIdentity(localSessionId, 'reviewer');
    calls.deleteSession.mockResolvedValueOnce({ status: 404, data: { success: false, error: 'Unknown localSessionId' } });

    await expect(adapter.deleteRoleSession({
      binding: {
        runId: 'run-1',
        roleId: 'reviewer',
        agentId: 'reviewer',
        endpointRef: openClawTestRuntimeEndpoint,
        localSessionId,
        endpointSessionId,
        sessionIdentity,
      },
    })).resolves.toBeUndefined();
    expect(calls.endpointSessionMaterialization.dematerializeEndpointSession).toHaveBeenCalled();
    expect(calls.agentRuntimeRegistry.forgetSessionContext).toHaveBeenCalledWith(sessionIdentity);
  });

  it('aborts through the existing session runtime service with the role SessionIdentity', async () => {
    const { adapter, calls } = createAdapter();
    const localSessionId = 'local:team-run:run-1:role:reviewer';
    const endpointSessionId = 'endpoint-session-run-1-reviewer';
    const sessionIdentity = createOpenClawTestSessionIdentity(localSessionId, 'reviewer');

    await adapter.abortRoleSession({
      binding: {
        runId: 'run-1',
        roleId: 'reviewer',
        agentId: 'reviewer',
        endpointRef: openClawTestRuntimeEndpoint,
        localSessionId,
        endpointSessionId,
        sessionIdentity,
      },
      runId: 'prompt-run-1',
    });

    expect(calls.abortSession).toHaveBeenCalledWith({
      sessionKey: localSessionId,
      endpointSessionId,
      sessionIdentity,
      runId: 'prompt-run-1',
    });
    expect(JSON.stringify(calls.abortSession.mock.calls)).not.toContain('sessions_spawn');
  });
});
