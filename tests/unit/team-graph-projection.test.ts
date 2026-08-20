import { describe, expect, it } from 'vitest';
import { projectCanvasGraphDefinition } from '@/services/team-graph-projection';

const graph = {
  graphId: 'graph:release',
  workflowPlanId: 'plan:release',
  runId: 'run:release',
  title: 'Release',
  nodes: [
    { nodeId: 'start', kind: 'start', title: 'Start', maxAttempts: 1, trigger: { kind: 'webhook', path: 'release' } },
    { nodeId: 'work', kind: 'work', title: 'Build', maxAttempts: 2, taskId: 'task:build', roleId: 'builder' },
    { nodeId: 'end', kind: 'end', title: 'End', maxAttempts: 1 },
  ],
  edges: [
    { edgeId: 'start-work', sourceNodeId: 'start', sourcePort: 'completed', targetNodeId: 'work', targetPort: 'input', action: 'activate' },
    { edgeId: 'work-end', sourceNodeId: 'work', sourcePort: 'completed', targetNodeId: 'end', targetPort: 'input', action: 'finish' },
  ],
};

describe('projectCanvasGraphDefinition', () => {
  it('maps only complete final facts without aliases or defaults', () => {
    expect(projectCanvasGraphDefinition(graph as never)).toEqual({
      graphId: 'graph:release',
      workflowPlanId: 'plan:release',
      runId: 'run:release',
      title: 'Release',
      nodes: [
        { id: 'start', kind: 'start', title: 'Start', maxAttempts: 1, trigger: { kind: 'webhook', path: 'release' } },
        { id: 'work', kind: 'work', title: 'Build', maxAttempts: 2, work: { taskId: 'task:build', roleId: 'builder' } },
        { id: 'end', kind: 'end', title: 'End', maxAttempts: 1 },
      ],
      edges: [
        { id: 'start-work', from: 'start', sourcePort: 'completed', to: 'work', targetPort: 'input', action: 'activate', payload: { includeUpstreamResult: true } },
        { id: 'work-end', from: 'work', sourcePort: 'completed', to: 'end', targetPort: 'input', action: 'finish', payload: { includeUpstreamResult: true } },
      ],
    });
  });

  it.each([
    ['graph status', { ...graph, status: 'running' }],
    ['canvas layout metadata', { ...graph, nodes: [{ ...graph.nodes[0], metadata: { position: { x: 1, y: 2 } } }, ...graph.nodes.slice(1)] }],
    ['executor configuration', { ...graph, nodes: [{ ...graph.nodes[0], executor: { kind: 'team-role' } }, ...graph.nodes.slice(1)] }],
    ['legacy prompt configuration', { ...graph, nodes: [{ ...graph.nodes[0], config: { prompt: 'hidden' } }, ...graph.nodes.slice(1)] }],
    ['webhook base URL', { ...graph, nodes: [{ ...graph.nodes[0], trigger: { kind: 'webhook', path: 'release', publicBaseUrl: 'https://example.test' } }, ...graph.nodes.slice(1)] }],
    ['edge alias', { ...graph, edges: [{ ...graph.edges[0], fromNodeId: 'start' }, ...graph.edges.slice(1)] }],
    ['edge payload policy shape', { ...graph, edges: [{ ...graph.edges[0], payload: { includeUpstreamResult: 'yes' } }, ...graph.edges.slice(1)] }],
    ['missing work task', { ...graph, nodes: [graph.nodes[0], { ...graph.nodes[1], taskId: undefined }, graph.nodes[2]] }],
  ])('rejects %s', (_reason, candidate) => {
    expect(() => projectCanvasGraphDefinition(candidate as never)).toThrow('Team graph contains unsupported or incomplete fact');
  });
});
