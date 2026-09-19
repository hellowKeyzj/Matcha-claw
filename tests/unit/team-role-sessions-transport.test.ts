import { describe, expect, it, vi } from 'vitest';
import { createTeamRoleSessionsTransport } from '../../electron/main/runtime-host-delivery/transport/teams/role-sessions';

const unavailable = { success: false, error: 'Team role sessions are unavailable' };

const endpointRef = {
  kind: 'native-runtime',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
} as const;

const roleSession = {
  teamId: 'team-1',
  runId: 'run-1',
  roleId: 'leader',
  sessionRef: 'rs0',
  status: 'available',
  agentId: 'leader-agent',
  endpointRef,
  localSessionId: 'agent:leader-agent:tr-run-1-leader-rs0',
  endpointSessionId: 'tr-run-1-leader-rs0',
  sessionIdentity: {
    endpoint: endpointRef,
    agentId: 'leader-agent',
    sessionKey: 'agent:leader-agent:tr-run-1-leader-rs0',
  },
} as const;

describe('Electron Main Team role-session transport', () => {
  it('signs and sends only the fixed sealed role-session request', async () => {
    const signDecision = vi.fn().mockReturnValue('signed-decision');
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ success: true, sessions: [roleSession] }),
    });
    const transport = createTeamRoleSessionsTransport({ verificationKey: 'public', signDecision }, 3242, fetcher);

    await expect(transport.list({ teamId: 'team-1' })).resolves.toEqual({
      status: 200,
      body: { success: true, sessions: [roleSession] },
    });
    expect(signDecision).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: '/api/team/role-sessions',
      scope: 'team:read',
      capability: 'team.role-sessions.list',
      subject: 'team-role-session-projection',
    }));
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:3242/api/team/role-sessions', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer signed-decision' }),
      body: JSON.stringify({ teamId: 'team-1' }),
    }));
  });

  it('does not sign invalid requests and rejects malformed native replies', async () => {
    const signDecision = vi.fn();
    const transport = createTeamRoleSessionsTransport({ verificationKey: 'public', signDecision }, 3242, vi.fn());
    await expect(transport.list({ teamId: 'team\n1' })).resolves.toEqual({ status: 503, body: unavailable });
    expect(signDecision).not.toHaveBeenCalled();

    const malformed = createTeamRoleSessionsTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      3242,
      vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({ success: true, sessions: [{ teamId: 'team-1', privateBinding: 'secret' }] }),
      }),
    );
    const response = await malformed.list({ teamId: 'team-1' });
    expect(response).toEqual({ status: 503, body: unavailable });
    expect(JSON.stringify(response)).not.toContain('privateBinding');
  });

  it('rejects role sessions whose identity fields disagree', async () => {
    const transport = createTeamRoleSessionsTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      3242,
      vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({
          success: true,
          sessions: [{
            ...roleSession,
            sessionIdentity: { ...roleSession.sessionIdentity, sessionKey: 'agent:other:x' },
          }],
        }),
      }),
    );

    await expect(transport.list({ teamId: 'team-1' })).resolves.toEqual({ status: 503, body: unavailable });
  });
});
