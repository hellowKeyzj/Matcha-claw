import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { handleTeamGraphRoutes } from '../../electron/api/routes/team-graph';

function request(body: unknown, method = 'POST') {
  return Object.assign(Readable.from([JSON.stringify(body)]), {
    method,
    headers: { 'content-type': 'application/json' },
  });
}

function response() {
  const state = { statusCode: 200, body: undefined as unknown };
  return {
    state,
    raw: {
      get statusCode() { return state.statusCode; },
      set statusCode(value: number) { state.statusCode = value; },
      setHeader: () => {},
      end: (content?: string) => { state.body = content ? JSON.parse(content) : undefined; },
    },
  };
}

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
      maxAttempts: 2,
      work: {
        taskId: 'task-1',
        roleId: 'role-1',
        prompt: 'Do the work',
        executor: { kind: 'team-role', roleId: 'role-1' },
        outputArtifactKind: 'report',
        groupId: 'group-1',
      },
    },
    {
      id: 'join',
      kind: 'join',
      title: 'Join',
      maxAttempts: 1,
      group: {
        groupId: 'group-1',
        join: { requireCompleted: true, allowFailed: false, retryLimit: 1 },
      },
    },
    { id: 'end', kind: 'end', title: 'End', maxAttempts: 1 },
  ],
  edges: [
    { id: 'edge-1', from: 'start', sourcePort: 'next', to: 'work', targetPort: 'in', action: 'activate' },
    {
      id: 'edge-2',
      from: 'work',
      sourcePort: 'next',
      to: 'join',
      targetPort: 'in',
      action: 'gate',
      payload: { includeUpstreamResult: true },
      dependency: { dependencyTaskId: 'task-0', taskId: 'task-1' },
    },
    { id: 'edge-3', from: 'join', sourcePort: 'next', to: 'end', targetPort: 'in', action: 'finish' },
  ],
};

const replaceRequest = {
  action: 'replace',
  teamId: 'team-1',
  idempotencyKey: 'replace-1',
  graph,
};

describe('Team graph Host API route', () => {
  it('forwards export, replace, and import using closed requests', async () => {
    const transport = {
      export: vi.fn().mockResolvedValue({ status: 200, body: { success: true, action: 'export', runId: 'run-1', yaml: 'graph: 1' } }),
      replace: vi.fn().mockResolvedValue({ status: 200, body: { success: true, action: 'replace', runId: 'run-1' } }),
      import: vi.fn().mockResolvedValue({ status: 200, body: { success: true, action: 'replace', runId: 'run-1' } }),
    };

    const cases = [
      [{ action: 'export', teamId: 'team-1', runId: 'run-1' }, transport.export, { teamId: 'team-1', runId: 'run-1' }],
      [replaceRequest, transport.replace, { teamId: 'team-1', idempotencyKey: 'replace-1', graph }],
      [{ action: 'import', teamId: 'team-1', idempotencyKey: 'import-1', yaml: 'graph: 1' }, transport.import, { teamId: 'team-1', idempotencyKey: 'import-1', yaml: 'graph: 1' }],
    ] as const;

    for (const [body, expected, forwarded] of cases) {
      const result = response();
      await expect(handleTeamGraphRoutes(
        request(body) as never,
        result.raw as never,
        new URL('http://127.0.0.1/api/team/graph'),
        transport,
      )).resolves.toBe(true);
      expect(expected).toHaveBeenCalledWith(forwarded);
      expect(result.state.statusCode).toBe(200);
    }
  });

  it('rejects lossy, extra, and malformed graph requests before transport invocation', async () => {
    const transport = { export: vi.fn(), replace: vi.fn(), import: vi.fn() };
    for (const body of [
      { action: 'replace', teamId: 'team-1', idempotencyKey: 'replace-1', graph: { ...graph, nodes: [{ id: 'work', kind: 'work', title: 'Work', maxAttempts: 1, work: { taskId: 'task-1' } }] } },
      { ...replaceRequest, unexpected: true },
      { action: 'replace', teamId: 'team-1', idempotencyKey: 'replace-1', graph: { ...graph, edges: [{ ...graph.edges[0], payload: { includeUpstreamResult: true, private: true } }] } },
      { action: 'import', teamId: 'team-1', idempotencyKey: 'invalid key', yaml: 'graph: 1' },
      { action: 'export', teamId: 'team-1', runId: 'run-1', commandId: 'not-allowed' },
    ]) {
      const result = response();
      await handleTeamGraphRoutes(
        request(body) as never,
        result.raw as never,
        new URL('http://127.0.0.1/api/team/graph'),
        transport,
      );
      expect(result.state).toEqual({
        statusCode: 400,
        body: { success: false, error: 'Team graph request is invalid' },
      });
    }
    expect(transport.export).not.toHaveBeenCalled();
    expect(transport.replace).not.toHaveBeenCalled();
    expect(transport.import).not.toHaveBeenCalled();
  });

  it('projects transport failures without native details', async () => {
    const result = response();
    await handleTeamGraphRoutes(
      request(replaceRequest) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/team/graph'),
      { export: vi.fn(), replace: vi.fn().mockRejectedValue(new Error('private native failure')), import: vi.fn() },
    );
    expect(result.state).toEqual({
      statusCode: 503,
      body: { success: false, error: 'Team graph is unavailable' },
    });
    expect(JSON.stringify(result.state)).not.toContain('private native failure');
  });
});
