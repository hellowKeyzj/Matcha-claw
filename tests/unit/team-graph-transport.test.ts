import { describe, expect, it, vi } from 'vitest';
import { createTeamGraphTransport } from '../../electron/main/runtime-host-delivery/transport/teams/graph';

const rejected = { success: false, error: 'Team graph update was rejected' };
const graph = {
  graphId: 'graph-1',
  workflowPlanId: 'plan-1',
  runId: 'run-1',
  title: 'Team graph',
  nodes: [
    { id: 'start', kind: 'start', title: 'Start', maxAttempts: 1 },
    {
      id: 'work',
      kind: 'work',
      title: 'Work',
      maxAttempts: 1,
      work: { taskId: 'task-1', roleId: 'role-1' },
    },
  ],
  edges: [{
    id: 'edge-1',
    from: 'start',
    sourcePort: 'next',
    to: 'work',
    targetPort: 'in',
    action: 'activate',
  }],
};

describe('Electron Main Team graph transport', () => {
  it('rejects control characters before signing or fetching', async () => {
    const signDecision = vi.fn();
    const fetcher = vi.fn();
    const transport = createTeamGraphTransport({ verificationKey: 'public', signDecision }, 3234, fetcher);

    for (const request of [
      () => transport.export({ teamId: 'team\n1', runId: 'run-1' }),
      () => transport.export({ teamId: 'team-1', runId: 'run-1' }),
      () => transport.replace({ teamId: 'team-1', idempotencyKey: 'replace-1', graph: { ...graph, title: 'Graph\r' } }),
    ]) {
      await expect(request()).resolves.toEqual({ status: 409, body: rejected });
    }

    expect(signDecision).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
