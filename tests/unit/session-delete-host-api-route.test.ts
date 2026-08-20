import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { handleCapabilityRoutes } from '../../electron/api/routes/capabilities';

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

function createRequest(input: Record<string, unknown> = {}) {
  return {
    id: 'session.prompt',
    operationId: 'sessions.create',
    scope: { kind: 'agent', endpoint, agentId: 'main' },
    target: { kind: 'agent', agentId: 'main' },
    input: { endpoint, agentId: 'main', endpointSessionId: 'session-1', ...input },
  };
}

function deleteRequest(input: Record<string, unknown> = {}) {
  return {
    id: 'session.management',
    operationId: 'sessions.delete',
    scope: { kind: 'session', identity },
    target: { kind: 'session', identity },
    input: { sessionIdentity: identity, ...input },
  };
}

function renameRequest(input: Record<string, unknown> = {}) {
  return {
    id: 'session.management',
    operationId: 'sessions.rename',
    scope: { kind: 'session', identity },
    target: { kind: 'session', identity },
    input: { sessionIdentity: identity, label: 'Renamed', ...input },
  };
}

describe('session Host API routes', () => {
  it('delegates only the exact create capability to its dedicated transport', async () => {
    const create = vi.fn().mockResolvedValue({ status: 200, body: { outcome: 'succeeded', sessionKey: 'agent:main:session-1' } });
    const remove = vi.fn();
    const list = vi.fn();
    const result = response();
    const body = createRequest();

    await expect(handleCapabilityRoutes(
      request(body) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      {
        licenseService: {} as never,
        sessionListTransport: { list },
        sessionCreateTransport: { create },
        sessionDeleteTransport: { delete: remove },
      } as never,
    )).resolves.toBe(true);

    expect(create).toHaveBeenCalledWith({
      id: 'session.prompt',
      operationId: 'sessions.create',
      scope: { kind: 'agent', endpoint, agentId: 'main' },
      target: { kind: 'agent', agentId: 'main' },
      input: { endpoint, agentId: 'main', endpointSessionId: 'session-1' },
    });
    expect(remove).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(result.state).toEqual({ statusCode: 200, body: { outcome: 'succeeded', sessionKey: 'agent:main:session-1' } });
  });

  it('delegates only the exact delete capability to its dedicated transport', async () => {
    const remove = vi.fn().mockResolvedValue({ status: 200, body: { outcome: 'succeeded' } });
    const list = vi.fn();
    const result = response();
    const body = deleteRequest();

    await expect(handleCapabilityRoutes(
      request(body) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      {
        licenseService: {} as never,
        sessionListTransport: { list },
        sessionCreateTransport: { create: vi.fn() },
        sessionDeleteTransport: { delete: remove },
      },
    )).resolves.toBe(true);

    expect(remove).toHaveBeenCalledWith({
      id: 'session.management',
      operationId: 'sessions.delete',
      scope: { kind: 'session', identity },
      target: { kind: 'session', identity },
      input: { sessionIdentity: identity },
    });
    expect(list).not.toHaveBeenCalled();
    expect(result.state).toEqual({ statusCode: 200, body: { outcome: 'succeeded' } });
  });

  it('delegates only the exact rename capability to its dedicated transport', async () => {
    const rename = vi.fn().mockResolvedValue({ status: 200, body: { outcome: 'succeeded' } });
    const remove = vi.fn();
    const list = vi.fn();
    const result = response();
    const body = renameRequest();

    await expect(handleCapabilityRoutes(
      request(body) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      {
        licenseService: {} as never,
        sessionListTransport: { list },
        sessionCreateTransport: { create: vi.fn() },
        sessionDeleteTransport: { delete: remove },
        sessionRenameTransport: { rename },
      } as never,
    )).resolves.toBe(true);

    expect(rename).toHaveBeenCalledWith({
      id: 'session.management',
      operationId: 'sessions.rename',
      scope: { kind: 'session', identity },
      target: { kind: 'session', identity },
      input: { sessionIdentity: identity, label: 'Renamed' },
    });
    expect(remove).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(result.state).toEqual({ statusCode: 200, body: { outcome: 'succeeded' } });
  });

  it('does not dispatch other session-management operations to the delete transport', async () => {
    const remove = vi.fn();
    const list = vi.fn().mockResolvedValue({ status: 200, body: { sessions: [] } });
    const result = response();

    await handleCapabilityRoutes(
      request({
        id: 'session.management',
        operationId: 'sessions.list',
        scope: { kind: 'runtime-instance', endpoint },
        target: { kind: 'runtime-endpoint' },
        input: { endpoint },
      }) as never,
      result.raw as never,
      new URL('http://localhost/api/capabilities/execute'),
      {
        licenseService: {} as never,
        sessionListTransport: { list },
        sessionCreateTransport: { create: vi.fn() },
        sessionDeleteTransport: { delete: remove },
      },
    );

    expect(list).toHaveBeenCalledOnce();
    expect(remove).not.toHaveBeenCalled();
    expect(result.state).toEqual({ statusCode: 200, body: { sessions: [] } });
  });
});
