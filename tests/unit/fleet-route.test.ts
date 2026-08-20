import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { RemoteFleetCredentialWriteError } from '../../electron/main/ipc/fleet-private';
import { handleFleetRoutes } from '../../electron/api/routes/fleet';

function incomingJson(body: unknown, method = 'POST') {
  return Object.assign(Readable.from([JSON.stringify(body)]), {
    method,
    headers: { 'content-type': 'application/json' },
  });
}

function incomingEmpty(method = 'GET') {
  return Object.assign(Readable.from([]), {
    method,
    headers: {},
  });
}

function incomingRaw(body: string, method = 'POST') {
  return Object.assign(Readable.from([body]), {
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

describe('fleet host API route', () => {
  it.each([
    ['/api/remote-fleet/list-audit-events', 'fleet.audit.list', { kind: 'audit' }, { audit: [] }],
    ['/api/remote-fleet/list-commands', 'fleet.commands.list', { kind: 'commands' }, { commands: [] }],
    ['/api/remote-fleet/metrics', 'fleet.metrics.get', { kind: 'metrics' }, { metrics: {} }],
    ['/api/remote-fleet/terminal/sessions', 'fleet.terminals.list', { kind: 'terminalList' }, { sessions: [] }],
  ] as const)('maps %s to a typed read request', async (pathname, operation, input, body) => {
    const read = vi.fn().mockResolvedValue({ status: 200, body });
    const result = response();

    await expect(handleFleetRoutes(
      incomingEmpty(),
      result.raw as never,
      new URL(`http://127.0.0.1${pathname}`),
      { read, mutate: vi.fn() },
    )).resolves.toBe(true);

    expect(read).toHaveBeenCalledWith({ operation, input });
    expect(result.state).toEqual({ statusCode: 200, body });
  });

  it('forwards the sealed snapshot without aggregating it in Electron', async () => {
    const snapshot = {
      connections: [],
      environments: [],
      managedResources: [],
      nodes: [],
      agents: [],
      runtimes: [],
      endpoints: [],
      capabilities: [],
      commands: [],
      leases: [],
      sessions: [],
      auditEvents: [],
      updatedAt: 'unix:1',
    };
    const read = vi.fn().mockResolvedValue({ status: 200, body: snapshot });
    const result = response();

    await handleFleetRoutes(
      incomingEmpty(),
      result.raw as never,
      new URL('http://127.0.0.1/api/remote-fleet/snapshot'),
      { read, mutate: vi.fn() },
    );

    expect(read).toHaveBeenCalledWith({
      operation: 'fleet.snapshot.get',
      input: { kind: 'snapshot' },
    });
    expect(result.state).toEqual({ statusCode: 200, body: snapshot });
  });

  it.each([
    ['/api/remote-fleet/probe', 'nodeId', 'fleet.commands.submit.node', 'nodeCommandSubmit', 'node-1', 'accepted'],
    ['/api/remote-fleet/install-agent', 'nodeId', 'fleet.commands.submit.node', 'nodeCommandSubmit', 'node-1', 'accepted'],
    ['/api/remote-fleet/delete-connection', 'connectionId', 'fleet.connections.remove', 'connectionRemove', 'connection-1', 'connectionRemoved'],
    ['/api/remote-fleet/remove-node', 'nodeId', 'fleet.nodes.retire', 'nodeRetire', 'node-1', 'nodeRetired'],
    ['/api/remote-fleet/revoke-agent', 'agentId', 'fleet.agents.revoke', 'agentRevoke', 'agent-1', 'agentRevoked'],
    ['/api/remote-fleet/drain-endpoint', 'endpointId', 'fleet.endpoints.drain', 'endpointDrain', 'endpoint-1', 'endpointDrained'],
    ['/api/remote-fleet/retire-endpoint', 'endpointId', 'fleet.endpoints.retire', 'endpointRetire', 'endpoint-1', 'endpointRetired'],
  ] as const)('maps %s to a typed mutation request', async (pathname, field, operation, kind, id, outcome) => {
    const mutate = vi.fn().mockResolvedValue({ status: 200, body: { outcome } });
    const result = response();

    await expect(handleFleetRoutes(
      incomingJson({ [field]: id }),
      result.raw as never,
      new URL(`http://127.0.0.1${pathname}`),
      { read: vi.fn(), mutate },
    )).resolves.toBe(true);

    if (operation === 'fleet.commands.submit.node') {
      expect(mutate).toHaveBeenCalledWith({
        operation,
        input: {
          kind,
          payload: expect.objectContaining({
            nodeId: id,
            kind: pathname === '/api/remote-fleet/probe' ? 'probeNode' : 'installAgent',
          }),
        },
      });
      expect(mutate.mock.calls[0][0].input.payload.commandId).toMatch(
        new RegExp(`^${pathname === '/api/remote-fleet/probe' ? 'probe' : 'install-agent'}:${id}:\\d+$`),
      );
    } else {
      expect(mutate).toHaveBeenCalledWith({
        operation,
        input: { kind, payload: { id } },
      });
    }
    expect(result.state).toEqual({ statusCode: 200, body: { outcome } });
  });

  it('registers a connection through signed mutation and canonical readback', async () => {
    const read = vi.fn()
      .mockResolvedValue({
        status: 200,
        body: {
          connections: [{
            id: 'connection-1',
            kind: 'sshHost',
            displayName: 'host',
            endpoint: 'ssh://host:22',
            labels: ['prod'],
            publicConfig: { host: 'host' },
            secretRefs: { privateKey: 'remote-fleet://ssh/key' },
            state: { kind: 'registered' },
            enabled: true,
            createdAt: '2026-08-08T10:00:00.000Z',
            updatedAt: '2026-08-08T10:00:00.000Z',
          }],
        },
      });
    const mutate = vi.fn().mockResolvedValue({ status: 200, body: { outcome: 'connectionUpdated' } });
    const result = response();

    await handleFleetRoutes(
      incomingJson({
        connection: {
          id: 'connection-1',
          displayName: 'host',
          connectionKind: 'ssh-host',
          endpointUrl: 'ssh://host:22',
          labels: ['prod'],
          enabled: true,
          publicConfig: { host: 'host' },
          secretRefs: { privateKey: { kind: 'secret-ref', ref: 'remote-fleet://ssh/key' } },
        },
      }),
      result.raw as never,
      new URL('http://127.0.0.1/api/remote-fleet/register-connection'),
      { read, mutate },
    );

    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ operation: 'fleet.connections.upsert' }));
    expect(read).toHaveBeenCalledWith({ operation: 'fleet.connections.list', input: { kind: 'connections' } });
    expect(result.state.statusCode).toBe(200);
    expect(result.state.body).toMatchObject({
      connection: {
        id: 'connection-1',
        connectionKind: 'ssh-host',
        targetKind: 'ssh-host',
        endpointUrl: 'ssh://host:22',
      },
      registration: {
        status: 'accepted',
        association: { connectionId: 'connection-1' },
      },
    });
    expect(JSON.stringify(result.state.body)).not.toContain('remote-fleet://ssh/key');
  });

  it('registers an environment only after canonical node, agent, and runtime readback', async () => {
    const read = vi.fn().mockImplementation(async (request: { operation: string }) => {
      if (request.operation === 'fleet.environments.list') {
        return {
          status: 200,
          body: {
            environments: [{
              id: 'environment-1',
              connectionId: 'connection-1',
              kind: 'sshWorkdir',
              displayName: 'workdir',
              labels: ['prod'],
              publicConfig: {},
              state: { kind: 'registered' },
              enabled: true,
              managedResourceCount: 0,
              createdAt: '2026-08-08T10:00:00.000Z',
              updatedAt: '2026-08-08T10:00:00.000Z',
            }],
          },
        };
      }
      return {
        status: 200,
        body: {
          nodes: [{ id: 'node-1', connectionId: 'connection-1', environmentId: 'environment-1', managedResourceId: null, health: 'unknown', observedAt: '2026-08-08T10:00:00.000Z', freshness: 'current' }],
          agents: [{ id: 'agent-1', nodeId: 'node-1', connectionId: 'connection-1', environmentId: 'environment-1', managedResourceId: null, observedAt: '2026-08-08T10:00:00.000Z', freshness: 'current' }],
          runtimes: [{ id: 'runtime-1', nodeId: 'node-1', agentId: 'agent-1', connectionId: 'connection-1', environmentId: 'environment-1', managedResourceId: null, kind: 'openClaw', state: 'discovered', observedAt: '2026-08-08T10:00:00.000Z', freshness: 'current' }],
          endpoints: [],
        },
      };
    });
    const mutate = vi.fn().mockResolvedValue({ status: 200, body: { outcome: 'environmentRegistered' } });
    const result = response();

    await handleFleetRoutes(
      incomingJson({
        environment: {
          id: 'environment-1',
          connectionId: 'connection-1',
          nodeId: 'node-1',
          displayName: 'workdir',
          environmentKind: 'ssh-workdir',
          enabled: true,
        },
      }),
      result.raw as never,
      new URL('http://127.0.0.1/api/remote-fleet/register-environment'),
      { read, mutate },
    );

    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ operation: 'fleet.environments.register' }));
    expect(read).toHaveBeenCalledTimes(2);
    expect(result.state).toMatchObject({
      statusCode: 200,
      body: {
        environment: { id: 'environment-1', connectionId: 'connection-1', targetKind: 'ssh-host' },
        node: { id: 'node-1', environmentId: 'environment-1' },
        agent: { id: 'agent-1', nodeId: 'node-1' },
        runtime: { id: 'runtime-1', agentId: 'agent-1' },
        registration: { status: 'accepted' },
      },
    });
  });

  it.each([
    { outcome: 'terminalClosed' },
    { outcome: 'error' },
  ] as const)('maps terminal close while omitting legacy reason from the typed request', async (body) => {
    const mutate = vi.fn().mockResolvedValue({ status: 200, body });
    const result = response();

    await expect(handleFleetRoutes(
      incomingJson({ sessionId: 'session-1', reason: 'drawer unmounted' }),
      result.raw as never,
      new URL('http://127.0.0.1/api/remote-fleet/terminal/close'),
      { read: vi.fn(), mutate },
    )).resolves.toBe(true);

    expect(mutate).toHaveBeenCalledWith({
      operation: 'fleet.terminals.close',
      input: {
        kind: 'terminalClose',
        payload: { sessionId: 'session-1' },
      },
    });
    expect(result.state).toEqual({ statusCode: 200, body });
  });

  it.each([
    {},
    { sessionId: '' },
    { sessionId: 'session id' },
    { sessionId: 42 },
  ])('rejects malformed terminal close identifiers without dispatch', async (body) => {
    const mutate = vi.fn();
    const result = response();

    await handleFleetRoutes(
      incomingJson(body),
      result.raw as never,
      new URL('http://127.0.0.1/api/remote-fleet/terminal/close'),
      { read: vi.fn(), mutate },
    );

    expect(mutate).not.toHaveBeenCalled();
    expect(result.state).toEqual({
      statusCode: 400,
      body: { success: false, error: 'Fleet request is invalid' },
    });
  });

  it('projects terminal close transport failures as unavailable', async () => {
    const result = response();

    await handleFleetRoutes(
      incomingJson({ sessionId: 'session-1', reason: 'done' }),
      result.raw as never,
      new URL('http://127.0.0.1/api/remote-fleet/terminal/close'),
      {
        read: vi.fn(),
        mutate: vi.fn().mockRejectedValue(new Error('private native terminal state')),
      },
    );

    expect(result.state).toEqual({
      statusCode: 503,
      body: { success: false, error: 'Fleet data is unavailable' },
    });
  });

  it('rejects malformed JSON before mutation dispatch', async () => {
    const mutate = vi.fn();
    const result = response();

    await handleFleetRoutes(
      incomingRaw('{"connectionId":'),
      result.raw as never,
      new URL('http://127.0.0.1/api/remote-fleet/delete-connection'),
      { read: vi.fn(), mutate },
    );

    expect(mutate).not.toHaveBeenCalled();
    expect(result.state).toEqual({
      statusCode: 400,
      body: { success: false, error: 'Fleet request is invalid' },
    });
  });

  it.each([
    { connectionId: '' },
    { connectionId: 'connection id' },
    { connectionId: 42 },
    {},
  ])('rejects malformed mutation identifiers without dispatch', async (body) => {
    const mutate = vi.fn();
    const result = response();

    await handleFleetRoutes(
      incomingJson(body),
      result.raw as never,
      new URL('http://127.0.0.1/api/remote-fleet/delete-connection'),
      { read: vi.fn(), mutate },
    );

    expect(mutate).not.toHaveBeenCalled();
    expect(result.state).toEqual({
      statusCode: 400,
      body: { success: false, error: 'Fleet request is invalid' },
    });
  });

  it.each([
    '/api/remote-fleet/probe-connection',
    '/api/remote-fleet/deploy-environment',
    '/api/remote-fleet/delete-environment',
  ])('rejects malformed mutation %s without leaking plaintext', async (pathname) => {
    const mutate = vi.fn();
    const result = response();
    const plaintext = 'plaintext-secret-must-not-cross-route';

    await handleFleetRoutes(
      incomingJson({ plaintextValue: plaintext, credentialId: 'credential-1' }),
      result.raw as never,
      new URL(`http://127.0.0.1${pathname}`),
      { read: vi.fn(), mutate },
    );

    expect(mutate).not.toHaveBeenCalled();
    expect(result.state).toEqual({
      statusCode: 400,
      body: { success: false, error: 'Fleet request is invalid' },
    });
    expect(JSON.stringify(result.state)).not.toContain(plaintext);
  });

  it('keeps credential writes unavailable when the private adapter is not injected', async () => {
    const mutate = vi.fn();
    const result = response();
    const plaintext = 'plaintext-secret-must-not-cross-route';

    await handleFleetRoutes(
      incomingJson({
        operationId: 'operation-1',
        credentialId: 'credential-1',
        credentialName: 'sshPassword',
        plaintextValue: plaintext,
      }),
      result.raw as never,
      new URL('http://127.0.0.1/api/remote-fleet/write-credential'),
      { read: vi.fn(), mutate },
    );

    expect(mutate).not.toHaveBeenCalled();
    expect(result.state).toEqual({
      statusCode: 503,
      body: { success: false, error: 'Fleet data is unavailable' },
    });
    expect(JSON.stringify(result.state)).not.toContain(plaintext);
  });

  it.each([
    '/api/remote-fleet/register-connection',
    '/api/remote-fleet/register-environment',
    '/api/remote-fleet/register',
    '/api/remote-fleet/probe-connection',
    '/api/remote-fleet/probe',
    '/api/remote-fleet/install-agent',
    '/api/remote-fleet/deploy-environment',
    '/api/remote-fleet/delete-environment',
    '/api/remote-fleet/write-credential',
    '/api/remote-fleet/terminal/open',
    '/api/remote-fleet/terminal/reconnect',
  ])('rejects malformed JSON on %s before unavailable projection', async (pathname) => {
    const mutate = vi.fn();
    const result = response();

    await handleFleetRoutes(
      incomingRaw('{"plaintextValue":'),
      result.raw as never,
      new URL(`http://127.0.0.1${pathname}`),
      { read: vi.fn(), mutate },
    );

    expect(mutate).not.toHaveBeenCalled();
    expect(result.state).toEqual({
      statusCode: 400,
      body: { success: false, error: 'Fleet request is invalid' },
    });
  });

  it('maps a credential write through the private adapter without exposing plaintext', async () => {
    const plaintext = 'private-secret';
    const adapter = vi.fn().mockResolvedValue({
      operationId: 'operation-1',
      credentialName: 'sshPassword',
      credentialRef: { kind: 'secret-ref', ref: 'remote-fleet://credentials/credential-1/sshPassword' },
      writtenAt: '2026-08-08T10:00:00.000Z',
    });
    const result = response();
    const body = {
      operationId: 'operation-1',
      credentialId: 'credential-1',
      credentialName: 'sshPassword',
      plaintextValue: plaintext,
    };

    await handleFleetRoutes(
      incomingJson(body),
      result.raw as never,
      new URL('http://127.0.0.1/api/remote-fleet/write-credential'),
      { read: vi.fn(), mutate: vi.fn() },
      adapter,
    );

    expect(adapter).toHaveBeenCalledWith(body);
    expect(result.state).toEqual({
      statusCode: 200,
      body: {
        operationId: 'operation-1',
        credentialName: 'sshPassword',
        credentialRef: { kind: 'secret-ref', ref: 'remote-fleet://credentials/credential-1/sshPassword' },
        writtenAt: '2026-08-08T10:00:00.000Z',
      },
    });
    expect(JSON.stringify(result.state)).not.toContain(plaintext);
  });

  it.each([
    { operationId: '', credentialId: 'credential-1', credentialName: 'sshPassword', plaintextValue: 'private-secret' },
    { operationId: 'operation-1', credentialId: 'credential-1', credentialName: 'unsupported', plaintextValue: 'private-secret' },
    { operationId: 'operation-1', credentialId: 'credential-1', credentialName: 'sshPassword', plaintextValue: '' },
    { operationId: 'operation-1', credentialId: 'credential-1', credentialName: 'sshPassword', plaintextValue: 'private-secret', extra: true },
  ])('rejects malformed credential write input without dispatch', async (body) => {
    const adapter = vi.fn();
    const result = response();

    await handleFleetRoutes(
      incomingJson(body),
      result.raw as never,
      new URL('http://127.0.0.1/api/remote-fleet/write-credential'),
      { read: vi.fn(), mutate: vi.fn() },
      adapter,
    );

    expect(adapter).not.toHaveBeenCalled();
    expect(result.state).toEqual({
      statusCode: 400,
      body: { success: false, error: 'Fleet request is invalid' },
    });
    expect(JSON.stringify(result.state)).not.toContain('private-secret');
  });

  it('projects credential conflicts as 409 without secret data', async () => {
    const adapter = vi.fn().mockRejectedValue(new RemoteFleetCredentialWriteError(
      'conflict',
      409,
      'Fleet credential operation conflicts with an existing receipt.',
    ));
    const result = response();

    await handleFleetRoutes(
      incomingJson({ operationId: 'operation-1', credentialId: 'credential-1', credentialName: 'sshPassword', plaintextValue: 'private-secret' }),
      result.raw as never,
      new URL('http://127.0.0.1/api/remote-fleet/write-credential'),
      { read: vi.fn(), mutate: vi.fn() },
      adapter,
    );

    expect(result.state).toEqual({
      statusCode: 409,
      body: { success: false, error: 'Fleet credential operation conflicts with an existing receipt.' },
    });
    expect(JSON.stringify(result.state)).not.toContain('private-secret');
  });

  it('projects credential writer failures as 503', async () => {
    const adapter = vi.fn().mockRejectedValue(new RemoteFleetCredentialWriteError(
      'unavailable',
      503,
      'Fleet credential writer is unavailable',
    ));
    const result = response();

    await handleFleetRoutes(
      incomingJson({ operationId: 'operation-1', credentialId: 'credential-1', credentialName: 'sshPassword', plaintextValue: 'private-secret' }),
      result.raw as never,
      new URL('http://127.0.0.1/api/remote-fleet/write-credential'),
      { read: vi.fn(), mutate: vi.fn() },
      adapter,
    );

    expect(result.state).toEqual({
      statusCode: 503,
      body: { success: false, error: 'Fleet credential writer is unavailable' },
    });
    expect(JSON.stringify(result.state)).not.toContain('private-secret');
  });

  it('projects malformed credential JSON as 400 before adapter dispatch', async () => {
    const adapter = vi.fn();
    const result = response();

    await handleFleetRoutes(
      incomingRaw('{"operationId":'),
      result.raw as never,
      new URL('http://127.0.0.1/api/remote-fleet/write-credential'),
      { read: vi.fn(), mutate: vi.fn() },
      adapter,
    );

    expect(adapter).not.toHaveBeenCalled();
    expect(result.state).toEqual({
      statusCode: 400,
      body: { success: false, error: 'Fleet request is invalid' },
    });
  });

  it('projects an invalid adapter receipt as unavailable', async () => {
    const adapter = vi.fn().mockResolvedValue({
      operationId: 'operation-1',
      credentialName: 'sshPassword',
      credentialRef: { kind: 'secret-ref', ref: 'remote-fleet://credentials/credential-1/sshPassword' },
      writtenAt: 'invalid',
    });
    const result = response();

    await handleFleetRoutes(
      incomingJson({ operationId: 'operation-1', credentialId: 'credential-1', credentialName: 'sshPassword', plaintextValue: 'private-secret' }),
      result.raw as never,
      new URL('http://127.0.0.1/api/remote-fleet/write-credential'),
      { read: vi.fn(), mutate: vi.fn() },
      adapter,
    );

    expect(result.state).toEqual({
      statusCode: 503,
      body: { success: false, error: 'Fleet data is unavailable' },
    });
  });

  it('projects transport failures as unavailable', async () => {
    const result = response();

    await handleFleetRoutes(
      incomingEmpty(),
      result.raw as never,
      new URL('http://127.0.0.1/api/remote-fleet/metrics'),
      {
        read: vi.fn().mockRejectedValue(new Error('private native token /secret/path')),
        mutate: vi.fn(),
      },
    );

    expect(result.state).toEqual({
      statusCode: 503,
      body: { success: false, error: 'Fleet data is unavailable' },
    });
    expect(JSON.stringify(result.state)).not.toContain('private native token');
    expect(JSON.stringify(result.state)).not.toContain('/secret/path');
  });

  it('returns false for paths and methods outside the Fleet boundary', async () => {
    const transport = { read: vi.fn(), mutate: vi.fn() };
    const result = response();

    await expect(handleFleetRoutes(
      incomingEmpty('GET'),
      result.raw as never,
      new URL('http://127.0.0.1/api/remote-fleet/unknown'),
      transport,
    )).resolves.toBe(false);
    await expect(handleFleetRoutes(
      incomingJson({}, 'PUT'),
      result.raw as never,
      new URL('http://127.0.0.1/api/remote-fleet/metrics'),
      transport,
    )).resolves.toBe(false);

    expect(transport.read).not.toHaveBeenCalled();
    expect(transport.mutate).not.toHaveBeenCalled();
  });
});
