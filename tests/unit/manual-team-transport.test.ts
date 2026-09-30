import { describe, expect, it, vi } from 'vitest';
import { createManualTeamTransport } from '../../electron/main/runtime-host-delivery/transport/teams/manual';

const request = {
  teamId: 'team:manual',
  teamName: 'Manual Team',
  idempotencyKey: 'manual:one',
  roles: [{
    roleId: 'leader',
    agentId: 'agent:lead',
    displayName: 'Lead',
    leader: true,
  }],
};

describe('Electron Main Manual Team transport', () => {
  it('signs and sends only the closed Manual Team delivery request', async () => {
    const signDecision = vi.fn().mockReturnValue('signed-decision');
    const fetcher = vi.fn().mockResolvedValue({
      status: 202,
      json: async () => ({ callId: 'a'.repeat(32), accepted: true }),
    });
    const transport = createManualTeamTransport({ verificationKey: 'public', signDecision }, 3235, fetcher);

    await expect(transport.materializeAndCreate(request)).resolves.toEqual({
      status: 202,
      body: { callId: 'a'.repeat(32), accepted: true },
    });
    expect(signDecision).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: '/api/team/manual-materialize-and-create',
      scope: 'team:write',
      capability: 'team.manual.materialize-and-create',
      subject: 'team-manual-materialize-and-create',
    }));
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:3235/api/team/manual-materialize-and-create',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer signed-decision' }),
        body: JSON.stringify(request),
      }),
    );
  });

  it('rejects legacy workspaceBinding and malformed or expanded native replies', async () => {
    const signDecision = vi.fn();
    const invalid = createManualTeamTransport({ verificationKey: 'public', signDecision }, 3235, vi.fn());
    await expect(invalid.materializeAndCreate({
      ...request,
      roles: [{ ...request.roles[0], workspaceBinding: 'binding.lead' }],
    })).resolves.toEqual({ status: 503, body: { success: false, error: 'Manual Team materialization is unavailable' } });
    expect(signDecision).not.toHaveBeenCalled();

    const malformed = createManualTeamTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      3235,
      vi.fn().mockResolvedValue({ status: 200, json: async () => ({ status: 'materialized', runId: 'private-run' }) }),
    );
    await expect(malformed.materializeAndCreate(request)).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Manual Team materialization is unavailable' },
    });
  });
});
