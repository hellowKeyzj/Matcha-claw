import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { handleTeamTaskBoardRoutes } from '../../electron/api/routes/team-task-board';

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

const mutations = [
  ['claimNext', { agentId: 'agent-1', session: 'session-1', leaseSeconds: 30, now: 1 }],
  ['heartbeat', { taskId: 'task-1', agentId: 'agent-1', session: 'session-1', leaseSeconds: 30, now: 1 }],
  ['release', { taskId: 'task-1', agentId: 'agent-1', session: 'session-1', now: 1 }],
  ['transition', { taskId: 'task-1', next: 'done', summary: null, error: null, now: 1 }],
  ['transition', { taskId: 'task-1', next: 'done', agentId: 'agent-1', session: 'session-1', summary: 'done', error: null, now: 1 }],
  ['startRunner', { runnerId: 'runner-1', session: 'session-1', now: 1 }],
  ['pauseRunner', { runnerId: 'runner-1', session: 'session-1', now: 1 }],
  ['closeRunner', { runnerId: 'runner-1', session: 'session-1', now: 1 }],
  ['reclaimExpired', { now: 1 }],
  ['postMailbox', {
    msgId: 'message-1',
    fromAgentId: 'agent-1',
    to: 'agent-2',
    relatedTaskId: null,
    replyToMsgId: null,
    kind: 'report',
    content: 'done',
    createdAt: 1,
  }],
  ['pullMailbox', { cursor: null, limit: 20 }],
  ['pullMailbox', { limit: 20 }],
  ['upsertPlan', {
    plan: [{ taskId: 'task-1', title: 'Task', instruction: 'Do task', dependsOn: [] }],
    now: 1,
    fingerprint: 'plan-1',
  }],
] as const;

describe('Team task board Host API route', () => {
  it('forwards the fixed read request and every closed mutation operation', async () => {
    const read = vi.fn().mockResolvedValue({
      status: 200,
      body: { success: true, action: 'read', tasks: [], runner: [], mailbox: [], cursor: '' },
    });
    const mutate = vi.fn().mockResolvedValue({ status: 200, body: { success: true, action: 'mutate' } });
    const transport = { read, mutate };

    const readResult = response();
    await expect(handleTeamTaskBoardRoutes(
      request({ action: 'read', teamId: 'team-1', runId: 'run-1' }) as never,
      readResult.raw as never,
      new URL('http://127.0.0.1/api/team/task-board'),
      transport,
    )).resolves.toBe(true);
    expect(read).toHaveBeenCalledWith({ teamId: 'team-1', runId: 'run-1' });
    expect(readResult.state).toEqual({
      statusCode: 200,
      body: { success: true, action: 'read', tasks: [], runner: [], mailbox: [], cursor: '' },
    });

    for (const [operation, payload] of mutations) {
      const body = { action: 'mutate' as const, teamId: 'team-1', runId: 'run-1', operation, payload };
      const result = response();
      await expect(handleTeamTaskBoardRoutes(
        request(body) as never,
        result.raw as never,
        new URL('http://127.0.0.1/api/team/task-board'),
        transport,
      )).resolves.toBe(true);
      expect(mutate).toHaveBeenLastCalledWith(body);
      expect(result.state).toEqual({ statusCode: 200, body: { success: true, action: 'mutate' } });
    }
  });

  it('rejects expanded and malformed requests before transport invocation', async () => {
    const transport = { read: vi.fn(), mutate: vi.fn() };
    for (const body of [
      { action: 'read', teamId: 'team-1', runId: 'run-1', receipt: 'private' },
      {
        action: 'mutate',
        teamId: 'team-1',
        runId: 'run-1',
        operation: 'claimNext',
        payload: { agentId: 'agent-1', session: 'session-1', leaseSeconds: 30, now: 1, secret: 'private' },
      },
      {
        action: 'mutate',
        teamId: 'team-1',
        runId: 'run-1',
        operation: 'transition',
        payload: { taskId: 'task-1', next: 'done', agentId: 'agent-1', summary: null, error: null, now: 1 },
      },
      {
        action: 'mutate',
        teamId: 'team-1',
        runId: 'run-1',
        operation: 'postMailbox',
        payload: {
          msgId: 'message-1',
          fromAgentId: 'agent-1',
          to: 'agent-2',
          relatedTaskId: null,
          replyToMsgId: null,
          kind: 'report',
          content: '',
          createdAt: 1,
        },
      },
    ]) {
      const result = response();
      await handleTeamTaskBoardRoutes(
        request(body) as never,
        result.raw as never,
        new URL('http://127.0.0.1/api/team/task-board'),
        transport,
      );
      expect(result.state).toEqual({
        statusCode: 400,
        body: { success: false, error: 'Team task board request is invalid' },
      });
    }
    expect(transport.read).not.toHaveBeenCalled();
    expect(transport.mutate).not.toHaveBeenCalled();
  });

  it('projects a fixed unavailable response when the transport throws', async () => {
    const result = response();
    await expect(handleTeamTaskBoardRoutes(
      request({ action: 'read', teamId: 'team-1', runId: 'run-1' }) as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/team/task-board'),
      { read: vi.fn().mockRejectedValue(new Error('private loopback failure')), mutate: vi.fn() },
    )).resolves.toBe(true);
    expect(result.state).toEqual({
      statusCode: 503,
      body: { success: false, error: 'Team task board is unavailable' },
    });
  });

  it('is registered by the Main server with its fixed transport', async () => {
    const read = vi.fn().mockResolvedValue({
      status: 200,
      body: { success: true, action: 'read', tasks: [], runner: [], mailbox: [], cursor: '' },
    });
    const result = response();
    const { createHostApiRequestHandler } = await import('../../electron/api/server');
    const handler = createHostApiRequestHandler({
      teamTaskBoardTransport: { read, mutate: vi.fn() },
    } as never, 13210);

    await handler(
      Object.assign(request({ action: 'read', teamId: 'team-1', runId: 'run-1' }), {
        url: '/api/team/task-board',
      }) as never,
      result.raw as never,
    );

    expect(read).toHaveBeenCalledWith({ teamId: 'team-1', runId: 'run-1' });
    expect(result.state).toEqual({
      statusCode: 200,
      body: { success: true, action: 'read', tasks: [], runner: [], mailbox: [], cursor: '' },
    });
  });

  it('does not claim unrelated methods or routes', async () => {
    await expect(handleTeamTaskBoardRoutes(
      request({ action: 'read', teamId: 'team-1', runId: 'run-1' }, 'GET') as never,
      response().raw as never,
      new URL('http://127.0.0.1/api/team/task-board'),
      { read: vi.fn(), mutate: vi.fn() },
    )).resolves.toBe(false);
  });
});
