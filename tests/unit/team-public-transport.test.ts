import { describe, expect, it, vi } from 'vitest';
import { createTeamPublicTransport } from '../../electron/main/runtime-host-delivery/transport/teams/public';

const projection = {
  teamId: 'team:one',
  runId: 'run:one',
  teamRevision: 1,
  runtime: 'unknown',
  graph: {
    graphId: 'graph:one',
    workflowPlanId: 'plan:one',
    title: 'Public graph',
    status: 'running',
    nodes: [{
      nodeId: 'node:one',
      kind: 'work',
      title: 'Public work',
      roleId: 'writer',
      taskId: 'draft',
      maxAttempts: 2,
      trigger: null,
      attempt: { number: 1, status: 'running', updatedAt: 10 },
    }],
    edges: [{
      edgeId: 'edge:one',
      sourceNodeId: 'node:one',
      sourcePort: 'completed',
      targetNodeId: 'node:two',
      targetPort: 'input',
      action: 'activate',
      status: 'waiting',
    }],
  },
};

describe('Electron Main Team public transport', () => {
  it('signs and sends the fixed public projection read', async () => {
    const signDecision = vi.fn().mockReturnValue('signed-decision');
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => projection,
    });
    const transport = createTeamPublicTransport({ verificationKey: 'public', signDecision }, 34_127, fetcher);

    await expect(transport.read({ teamId: 'team:one', runId: 'run:one' })).resolves.toEqual({
      status: 200,
      body: projection,
    });
    expect(signDecision).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: '/api/team/public',
      scope: 'team:read',
      capability: 'team.public.read',
      subject: 'team-public-projection',
    }));
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:34127/api/team/public', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer signed-decision' }),
      body: JSON.stringify({ teamId: 'team:one', runId: 'run:one' }),
    }));
  });

  it('passes through only the fixed unavailable result', async () => {
    const transport = createTeamPublicTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_127,
      vi.fn().mockResolvedValue({
        status: 404,
        json: async () => ({ success: false, error: 'Team public projection is unavailable' }),
      }),
    );

    await expect(transport.read({ teamId: 'team:one', runId: 'run:missing' })).resolves.toEqual({
      status: 404,
      body: { success: false, error: 'Team public projection is unavailable' },
    });
  });

  it('rejects malformed, private, and failed native responses without exposing details', async () => {
    const malformed = createTeamPublicTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_127,
      vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({ ...projection, diagnostics: 'private runtime error' }),
      }),
    );
    const failed = createTeamPublicTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_127,
      vi.fn().mockRejectedValue(new Error('private loopback failure')),
    );

    await expect(malformed.read({ teamId: 'team:one', runId: 'run:one' })).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Team public projection is unavailable' },
    });
    const response = await failed.read({ teamId: 'team:one', runId: 'run:one' });
    expect(response).toEqual({
      status: 503,
      body: { success: false, error: 'Team public projection is unavailable' },
    });
    expect(JSON.stringify(response)).not.toContain('private loopback failure');
  });

  it('does not issue a decision for an invalid public request', async () => {
    const signDecision = vi.fn();
    const fetcher = vi.fn();
    const transport = createTeamPublicTransport({ verificationKey: 'public', signDecision }, 34_127, fetcher);

    await expect(transport.read({ teamId: '', runId: 'run:one' })).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Team public projection is unavailable' },
    });
    expect(signDecision).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
