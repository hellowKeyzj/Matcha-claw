import { describe, expect, it, vi } from 'vitest';
import { createTeamApprovalsTransport } from '../../electron/main/runtime-host-delivery/transport/teams/approvals';

const projection = {
  teamId: 'team:one',
  runId: 'run:one',
  approvals: [{
    approvalId: 'approval:one',
    stageId: 'stage:one',
    roleId: 'writer',
    reason: 'Review required',
    requestedAction: 'Approve publication',
    createdAt: 10,
  }],
};

describe('Electron Main Team approvals transport', () => {
  it('signs and sends the fixed pending approvals read', async () => {
    const signDecision = vi.fn().mockReturnValue('signed-decision');
    const fetcher = vi.fn().mockResolvedValue({ status: 200, json: async () => projection });
    const transport = createTeamApprovalsTransport({ verificationKey: 'public', signDecision }, 34_128, fetcher);

    await expect(transport.read({ teamId: 'team:one', runId: 'run:one' })).resolves.toEqual({
      status: 200,
      body: projection,
    });
    expect(signDecision).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: '/api/team/approvals',
      scope: 'team:read',
      capability: 'team.approvals.list',
      subject: 'team-pending-approvals',
    }));
  });

  it('rejects native data outside the fixed approval projection', async () => {
    const transport = createTeamApprovalsTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_128,
      vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({ ...projection, receipts: ['private receipt'] }),
      }),
    );

    await expect(transport.read({ teamId: 'team:one', runId: 'run:one' })).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Team pending approvals are unavailable' },
    });
  });
});
