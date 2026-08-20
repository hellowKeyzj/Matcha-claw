import { describe, expect, it, vi } from 'vitest';
import { decodeTeamPublicProjection, readTeamPublicProjection } from '@/services/team-public-projection';
import { hostApiFetchDecoded } from '@/lib/host-api';

vi.mock('@/lib/host-api', () => ({
  hostApiFetchDecoded: vi.fn(),
}));

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

describe('Team public projection renderer contract', () => {
  it('uses a sealed JSON request body for the fixed public route', async () => {
    vi.mocked(hostApiFetchDecoded).mockResolvedValueOnce(projection);

    await expect(readTeamPublicProjection({ teamId: 'team:one', runId: 'run:one' })).resolves.toEqual(projection);
    expect(hostApiFetchDecoded).toHaveBeenCalledWith(
      '/api/team/public',
      decodeTeamPublicProjection,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamId: 'team:one', runId: 'run:one' }),
      },
    );
  });

  it('rejects extra and private fields rather than widening the renderer contract', () => {
    expect(decodeTeamPublicProjection(projection)).toEqual(projection);
    expect(() => decodeTeamPublicProjection({
      ...projection,
      diagnostics: 'private native error',
    })).toThrow('Invalid Team public projection');
    expect(() => decodeTeamPublicProjection({
      ...projection,
      graph: { ...projection.graph, nodes: [{ ...projection.graph.nodes[0], prompt: 'private prompt' }] },
    })).toThrow('Invalid Team public projection');
  });
});
