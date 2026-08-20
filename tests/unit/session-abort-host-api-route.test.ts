import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { handleCapabilityRoutes } from '../../electron/api/routes/capabilities';

const matchaApprovalIdentity = {
  endpoint: {
    kind: 'native-runtime',
    runtimeAdapterId: 'matcha-agent',
    runtimeInstanceId: 'local',
  },
  agentId: 'main',
  sessionKey: 'matcha-session-1',
} as const;

const endpoint = {
  kind: 'native-runtime',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
} as const;

const identity = {
  endpoint,
  agentId: 'main',
  sessionKey: 'agent:main:demo',
} as const;

function request(body: unknown) {
  return Object.assign(Readable.from([JSON.stringify(body)]), {
    method: 'POST',
    headers: { 'content-length': '1' },
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

function abortRequest(input: Record<string, unknown> = {}) {
  return {
    id: 'session.abort',
    operationId: 'sessions.abort',
    scope: { kind: 'session', identity },
    target: { kind: 'session', identity },
    input: { sessionKey: identity.sessionKey, sessionIdentity: identity, ...input },
  };
}

function approvalRequest(operationId: 'approvals.list' | 'approvals.resolve') {
  return operationId === 'approvals.list'
    ? {
      id: 'session.approval',
      operationId,
      scope: { kind: 'session', identity: matchaApprovalIdentity },
      target: { kind: 'session', identity: matchaApprovalIdentity },
      input: { sessionIdentity: matchaApprovalIdentity },
    }
    : {
      id: 'session.approval',
      operationId,
      scope: { kind: 'session', identity: matchaApprovalIdentity },
      target: { kind: 'approval', identity: matchaApprovalIdentity, approvalId: 'approval-1' },
      input: {
        sessionKey: matchaApprovalIdentity.sessionKey,
        sessionIdentity: matchaApprovalIdentity,
        id: 'approval-1',
        decision: 'allow-once',
      },
    };
}

describe('session abort Host API route', () => {
  it('projects the renderer identity to the narrow Rust abort request', async () => {
    const abort = vi.fn().mockResolvedValue({ status: 200, body: { outcome: 'succeeded' } });
    const result = response();

    await expect(handleCapabilityRoutes(
      request(abortRequest({ runId: 'run-1' })) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      {
        licenseService: {} as never,
        sessionListTransport: {} as never,
        sessionAbortTransport: { abort },
        sessionSendTransport: {} as never,
      },
    )).resolves.toBe(true);

    expect(abort).toHaveBeenCalledWith({
      id: 'session.abort',
      operationId: 'sessions.abort',
      scope: { kind: 'session', endpoint, sessionKey: identity.sessionKey },
      target: { kind: 'session' },
      input: { endpoint, sessionKey: identity.sessionKey, runId: 'run-1' },
    });
    expect(result.state).toEqual({ statusCode: 200, body: { outcome: 'succeeded' } });
  });

  it('forwards the public approval list envelope to the native approval transport', async () => {
    const list = vi.fn().mockResolvedValue({
      status: 200,
      body: { approvals: [{ approvalId: 'approval-1', optionIds: ['allow_once'] }] },
    });
    const respond = vi.fn();
    const result = response();

    await handleCapabilityRoutes(
      request(approvalRequest('approvals.list')) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      {
        licenseService: {} as never,
        sessionListTransport: {} as never,
        sessionApprovalTransport: { list, respond },
      } as never,
    );

    expect(list).toHaveBeenCalledWith({
      id: 'session.approval',
      operationId: 'sessions.approvals.list',
      scope: {
        kind: 'session',
        endpoint: matchaApprovalIdentity.endpoint,
        sessionId: matchaApprovalIdentity.sessionKey,
      },
      target: { kind: 'session' },
      input: {
        endpoint: matchaApprovalIdentity.endpoint,
        sessionId: matchaApprovalIdentity.sessionKey,
      },
    });
    expect(respond).not.toHaveBeenCalled();
    expect(result.state).toEqual({
      statusCode: 200,
      body: { approvals: [{ approvalId: 'approval-1', optionIds: ['allow_once'] }] },
    });
  });

  it('maps the public approval decision to a native option id', async () => {
    const list = vi.fn();
    const respond = vi.fn().mockResolvedValue({ status: 200, body: { outcome: 'responded' } });
    const result = response();

    await handleCapabilityRoutes(
      request(approvalRequest('approvals.resolve')) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      {
        licenseService: {} as never,
        sessionListTransport: {} as never,
        sessionApprovalTransport: { list, respond },
      } as never,
    );

    expect(respond).toHaveBeenCalledWith({
      id: 'session.approval',
      operationId: 'sessions.approvals.respond',
      scope: {
        kind: 'session',
        endpoint: matchaApprovalIdentity.endpoint,
        sessionId: matchaApprovalIdentity.sessionKey,
      },
      target: { kind: 'approval' },
      input: {
        endpoint: matchaApprovalIdentity.endpoint,
        sessionId: matchaApprovalIdentity.sessionKey,
        approvalId: 'approval-1',
        optionId: 'allow_once',
      },
    });
    expect(list).not.toHaveBeenCalled();
    expect(result.state).toEqual({
      statusCode: 200,
      body: { outcome: 'responded' },
    });
  });

  it.each([
    { operationId: 'approvals.list', input: { sessionIdentity: matchaApprovalIdentity, extra: true } },
    { operationId: 'approvals.resolve', input: {
      sessionKey: matchaApprovalIdentity.sessionKey,
      sessionIdentity: matchaApprovalIdentity,
      id: 'approval-1',
      decision: 'maybe',
    } },
  ] as const)('rejects malformed public approval envelope %s without delivery', async ({ operationId, input }) => {
    const list = vi.fn();
    const respond = vi.fn();
    const result = response();
    const body = operationId === 'approvals.list'
      ? {
        id: 'session.approval',
        operationId,
        scope: { kind: 'session', identity: matchaApprovalIdentity },
        target: { kind: 'session', identity: matchaApprovalIdentity },
        input,
      }
      : {
        id: 'session.approval',
        operationId,
        scope: { kind: 'session', identity: matchaApprovalIdentity },
        target: { kind: 'approval', identity: matchaApprovalIdentity, approvalId: 'approval-1' },
        input,
      };

    await handleCapabilityRoutes(
      request(body) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      {
        licenseService: {} as never,
        sessionListTransport: {} as never,
        sessionApprovalTransport: { list, respond },
      } as never,
    );

    expect(list).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
    expect(result.state).toEqual({
      statusCode: 500,
      body: { success: false, error: 'Capability request failed' },
    });
  });

  it('rejects lower approval operations at the capability boundary', async () => {
    const list = vi.fn();
    const result = response();
    const lowerRequest = {
      id: 'session.approval',
      operationId: 'sessions.approvals.list',
      scope: {
        kind: 'session',
        endpoint: matchaApprovalIdentity.endpoint,
        sessionId: 'native-session-1',
      },
      target: { kind: 'session' },
      input: {
        endpoint: matchaApprovalIdentity.endpoint,
        sessionId: 'native-session-1',
      },
    };

    await handleCapabilityRoutes(
      request(lowerRequest) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      {
        licenseService: {} as never,
        sessionListTransport: {} as never,
        sessionApprovalTransport: { list, respond: vi.fn() },
      } as never,
    );

    expect(list).not.toHaveBeenCalled();
    expect(result.state).toEqual({
      statusCode: 404,
      body: { success: false, error: 'Capability is not available' },
    });
  });

  it('forwards legacy approval ids to the native abort transport without run identity', async () => {
    const abort = vi.fn().mockResolvedValue({ status: 200, body: { outcome: 'unknown' } });
    const result = response();

    await expect(handleCapabilityRoutes(
      request(abortRequest({ approvalIds: ['approval-1'] })) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      {
        licenseService: {} as never,
        sessionListTransport: {} as never,
        sessionAbortTransport: { abort },
        sessionSendTransport: {} as never,
      },
    )).resolves.toBe(true);

    expect(abort).toHaveBeenCalledWith({
      id: 'session.abort',
      operationId: 'sessions.abort',
      scope: { kind: 'session', endpoint, sessionKey: identity.sessionKey },
      target: { kind: 'session' },
      input: {
        endpoint,
        sessionKey: identity.sessionKey,
        approvalIds: ['approval-1'],
      },
    });
    expect(result.state).toEqual({ statusCode: 200, body: { outcome: 'unknown' } });
  });
});
