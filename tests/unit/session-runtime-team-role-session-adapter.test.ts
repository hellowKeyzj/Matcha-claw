import { describe, expect, it, vi } from 'vitest';
import { SessionRuntimeTeamRoleSessionAdapter } from '../../runtime-host/application/team-runtime/adapters/session-runtime-team-role-session-adapter';
import { createOpenClawTestSessionIdentity } from './helpers/runtime-address-fixtures';

function createAdapter() {
  const calls = {
    createSession: vi.fn(async () => ({ status: 200, data: { success: true } })),
    promptSession: vi.fn(async (payload: unknown) => ({
      status: 200,
      data: {
        success: true,
        sessionKey: (payload as { sessionKey: string }).sessionKey,
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
    endpointSessionMaterialization: {
      materializeEndpointSession: vi.fn(async () => undefined),
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
    const sessionIdentity = createOpenClawTestSessionIdentity('team:run-1:role:reviewer', 'reviewer');

    const binding = await adapter.ensureRoleSession({
      runId: 'run-1',
      roleId: 'reviewer',
      agentId: 'reviewer',
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
      sessionIdentity,
      sessionKey: 'team:run-1:role:reviewer',
    });
    expect(calls.createSession).toHaveBeenCalledWith({
      sessionKey: 'team:run-1:role:reviewer',
      endpoint: sessionIdentity.endpoint,
      agentId: 'reviewer',
    });
    expect(calls.endpointSessionMaterialization.materializeEndpointSession).toHaveBeenCalledWith(binding);
    expect(calls.promptSession).toHaveBeenCalledWith({
      sessionKey: 'team:run-1:role:reviewer',
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
      sessionKey: 'team:run-1:role:reviewer',
      promptRunId: 'prompt-run-1',
    });
  });

  it('passes displayMessage separately from the delivered TeamRun prompt', async () => {
    const { adapter, calls } = createAdapter();
    const sessionIdentity = createOpenClawTestSessionIdentity('agent:mct-team:team-role:run-1:leader', 'mct-team');

    await adapter.promptRoleSession({
      binding: {
        runId: 'run-1',
        roleId: 'leader',
        agentId: 'mct-team',
        sessionIdentity,
        sessionKey: sessionIdentity.sessionKey,
      },
      message: '## TeamRun WorkNode\nfull prompt',
      displayMessage: '用户原文',
      idempotencyKey: 'prompt-run-1',
    });

    expect(calls.promptSession).toHaveBeenCalledWith({
      sessionKey: 'agent:mct-team:team-role:run-1:leader',
      sessionIdentity,
      message: '## TeamRun WorkNode\nfull prompt',
      displayMessage: '用户原文',
      idempotencyKey: 'prompt-run-1',
    });
  });

  it('fails ensure when endpoint session materialization fails after Matcha session creation', async () => {
    const { adapter, calls } = createAdapter();
    const sessionIdentity = createOpenClawTestSessionIdentity('agent:mct-team:team-role:run-1:reviewer', 'mct-team');
    calls.endpointSessionMaterialization.materializeEndpointSession.mockRejectedValueOnce(new Error('sessions.create failed'));

    await expect(adapter.ensureRoleSession({
      runId: 'run-1',
      roleId: 'reviewer',
      agentId: 'mct-team',
      sessionIdentity,
    })).rejects.toThrow('sessions.create failed');
    expect(calls.createSession).toHaveBeenCalledWith({
      sessionKey: 'agent:mct-team:team-role:run-1:reviewer',
      endpoint: sessionIdentity.endpoint,
      agentId: 'mct-team',
    });
    expect(calls.endpointSessionMaterialization.materializeEndpointSession).toHaveBeenCalledTimes(1);
  });

  it('rejects a binding when the requested agentId differs from SessionIdentity.agentId', async () => {
    const { adapter, calls } = createAdapter();
    const sessionIdentity = createOpenClawTestSessionIdentity('team:run-1:role:reviewer', 'reviewer');

    await expect(adapter.ensureRoleSession({
      runId: 'run-1',
      roleId: 'reviewer',
      agentId: 'writer',
      sessionIdentity,
    })).rejects.toThrow('Team role agentId writer must match SessionIdentity.agentId reviewer.');
    expect(calls.createSession).not.toHaveBeenCalled();
  });

  it('returns a hydrating read window as an actionable pending result', async () => {
    const { adapter, calls } = createAdapter();
    const sessionIdentity = createOpenClawTestSessionIdentity('team:run-1:role:reviewer', 'reviewer');
    calls.getSessionWindow.mockResolvedValueOnce({
      status: 202,
      data: { hydrationJob: { id: 'hydrate-1', status: 'queued' } },
    });

    const result = await adapter.readRoleSessionWindow({
      binding: {
        runId: 'run-1',
        roleId: 'reviewer',
        agentId: 'reviewer',
        sessionIdentity,
        sessionKey: sessionIdentity.sessionKey,
      },
      limit: 20,
    });

    expect(calls.getSessionWindow).toHaveBeenCalledWith({
      sessionKey: 'team:run-1:role:reviewer',
      sessionIdentity,
      limit: 20,
    });
    expect(result).toEqual({
      resultType: 'pending_hydration',
      sessionKey: 'team:run-1:role:reviewer',
      message: 'Session window for Team role reviewer is hydrating. Retry readRoleSessionWindow after the queued hydration job completes.',
    });
  });

  it('deletes through the existing session runtime service with the role SessionIdentity', async () => {
    const { adapter, calls } = createAdapter();
    const sessionIdentity = createOpenClawTestSessionIdentity('team:run-1:role:reviewer', 'reviewer');

    await adapter.deleteRoleSession({
      binding: {
        runId: 'run-1',
        roleId: 'reviewer',
        agentId: 'reviewer',
        sessionIdentity,
        sessionKey: sessionIdentity.sessionKey,
      },
    });

    expect(calls.deleteSession).toHaveBeenCalledWith({
      sessionKey: 'team:run-1:role:reviewer',
      sessionIdentity,
    });
  });

  it('treats an already-missing role session as deleted', async () => {
    const { adapter, calls } = createAdapter();
    const sessionIdentity = createOpenClawTestSessionIdentity('team:run-1:role:reviewer', 'reviewer');
    calls.deleteSession.mockResolvedValueOnce({ status: 404, data: { success: false, error: 'Unknown sessionKey' } });

    await expect(adapter.deleteRoleSession({
      binding: {
        runId: 'run-1',
        roleId: 'reviewer',
        agentId: 'reviewer',
        sessionIdentity,
        sessionKey: sessionIdentity.sessionKey,
      },
    })).resolves.toBeUndefined();
  });

  it('aborts through the existing session runtime service with the role SessionIdentity', async () => {
    const { adapter, calls } = createAdapter();
    const sessionIdentity = createOpenClawTestSessionIdentity('team:run-1:role:reviewer', 'reviewer');

    await adapter.abortRoleSession({
      binding: {
        runId: 'run-1',
        roleId: 'reviewer',
        agentId: 'reviewer',
        sessionIdentity,
        sessionKey: sessionIdentity.sessionKey,
      },
      runId: 'prompt-run-1',
    });

    expect(calls.abortSession).toHaveBeenCalledWith({
      sessionKey: 'team:run-1:role:reviewer',
      sessionIdentity,
      runId: 'prompt-run-1',
    });
    expect(JSON.stringify(calls.abortSession.mock.calls)).not.toContain('sessions_spawn');
  });
});
