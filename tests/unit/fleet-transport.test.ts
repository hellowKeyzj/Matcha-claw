import { createServer, request as httpRequest } from 'node:http';
import { connect, createServer as createTcpServer, type AddressInfo, type Server as NetServer, type Socket } from 'node:net';
import { describe, expect, it, vi } from 'vitest';

import {
  createFleetTransport,
  isFleetMutationRequest,
  proxyFleetRuntimeAgentIngress,
  proxyFleetTerminalStreamUpgrade,
} from '../../electron/main/runtime-host-delivery/transport/fleet';

const snapshot = {
  connections: [{
    id: 'connection-1',
    displayName: 'Primary SSH',
    connectionKind: 'ssh-host',
    status: 'online',
    labels: ['production'],
    enabled: true,
    createdAt: 'unix:1',
    updatedAt: 'unix:2',
  }],
  environments: [{
    id: 'environment-1',
    connectionId: 'connection-1',
    displayName: 'Production',
    environmentKind: 'ssh-workdir',
    status: 'ready',
    labels: ['production'],
    enabled: true,
    createdAt: 'unix:1',
    updatedAt: 'unix:2',
  }],
  managedResources: [{
    id: 'resource-1',
    connectionId: 'connection-1',
    environmentId: 'environment-1',
    providerKind: 'ssh',
    resourceKind: 'ssh-agent-installation',
    remoteResourceId: 'remote-resource-1',
    status: 'ready',
    ownership: 'matchaManaged',
    cleanupPolicy: 'uninstallAgentOnly',
    createdAt: 'unix:1',
    updatedAt: 'unix:2',
  }],
  nodes: [{
    id: 'node-1',
    connectionId: 'connection-1',
    environmentId: 'environment-1',
    managedResourceId: 'resource-1',
    status: 'online',
    lastSeenAt: 'unix:2',
  }],
  agents: [{
    id: 'agent-1',
    connectionId: 'connection-1',
    environmentId: 'environment-1',
    managedResourceId: 'resource-1',
    nodeId: 'node-1',
  }],
  runtimes: [{
    id: 'runtime-1',
    connectionId: 'connection-1',
    environmentId: 'environment-1',
    managedResourceId: 'resource-1',
    nodeId: 'node-1',
    agentId: 'agent-1',
    status: 'running',
    startedAt: 'unix:2',
  }],
  endpoints: [{
    id: 'endpoint-1',
    connectionId: 'connection-1',
    environmentId: 'environment-1',
    managedResourceId: 'resource-1',
    nodeId: 'node-1',
    runtimeId: 'runtime-1',
    status: 'ready',
    lastProbeAt: 'unix:2',
  }],
  capabilities: [{
    id: 'capability-1',
    endpointId: 'endpoint-1',
    nodeId: 'node-1',
    runtimeId: 'runtime-1',
    status: 'current',
  }],
  commands: [{
    id: 'command-1',
    command: 'probeNode',
    status: 'succeeded',
    createdAt: 'unix:1',
    updatedAt: 'unix:2',
    nodeId: 'node-1',
  }],
  leases: [{
    id: 'lease-1',
    endpointId: 'endpoint-1',
    ownerKind: 'session',
    ownerId: 'session-1',
    status: 'active',
    expiresAt: 'unix:3',
  }],
  sessions: [{
    id: 'session-1',
    nodeId: 'node-1',
    status: 'connected',
    createdAt: 'unix:1',
    updatedAt: 'unix:2',
    expiresAt: 'unix:3',
  }],
  auditEvents: [{
    id: 'audit:1',
    eventName: 'connection.updated',
    occurredAt: 'unix:2',
    connectionId: 'connection-1',
    environmentId: 'environment-1',
    managedResourceId: 'resource-1',
    nodeId: 'node-1',
    agentId: 'agent-1',
    runtimeId: 'runtime-1',
    endpointId: 'endpoint-1',
    commandId: 'command-1',
  }],
  updatedAt: 'unix:3',
} as const;

function issuer() {
  return {
    verificationKey: 'public',
    signDecision: vi.fn().mockReturnValue('signed-decision'),
  };
}

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function listenTcp(server: NetServer): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function closeTcp(server: NetServer): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

type CapturedIngress = Readonly<{
  path: string | undefined;
  body: string;
  authorization: string | string[] | undefined;
  enrollment: string | string[] | undefined;
  contentType: string | string[] | undefined;
}>;

describe('Electron Main Fleet runtime agent ingress proxy', () => {
  it('forwards runtime-agent credentials and body unchanged', async () => {
    const body = JSON.stringify({ kind: 'heartbeat', agentId: 'agent-1' });
    let resolveCaptured!: (value: CapturedIngress) => void;
    const captured = new Promise<CapturedIngress>((resolve) => {
      resolveCaptured = resolve;
    });
    const upstream = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      resolveCaptured({
        path: req.url,
        body: Buffer.concat(chunks).toString('utf8'),
        authorization: req.headers.authorization,
        enrollment: req.headers['x-matchaclaw-runtime-agent-ingress-credential'],
        contentType: req.headers['content-type'],
      });
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end('{"accepted":true}');
    });
    const upstreamPort = await listen(upstream);
    const proxy = createServer((req, res) => proxyFleetRuntimeAgentIngress(upstreamPort, req, res));

    try {
      const proxyPort = await listen(proxy);
      const response = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
        const request = httpRequest({
          hostname: '127.0.0.1',
          port: proxyPort,
          method: 'POST',
          path: '/api/remote-fleet/runtime-agent/ingress?client=query',
          headers: {
            Authorization: 'Bearer runtime-agent-token',
            'Content-Type': 'application/json',
            'X-MatchaClaw-Runtime-Agent-Ingress-Credential': 'enroll-secret',
          },
        }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
          res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        });
        request.on('error', reject);
        request.end(body);
      });

      await expect(captured).resolves.toEqual({
        path: '/api/remote-fleet/runtime-agent/ingress',
        body,
        authorization: 'Bearer runtime-agent-token',
        enrollment: 'enroll-secret',
        contentType: 'application/json',
      });
      expect(response).toEqual({ status: 202, body: '{"accepted":true}' });
    } finally {
      await close(proxy);
      await close(upstream);
    }
  });
});

describe('Electron Main Fleet terminal stream proxy', () => {
  it('rewrites the public upgrade path and pipes upgrade head plus post-upgrade bytes both ways', async () => {
    let upstreamSocket: Socket | undefined;
    let resolveUpgrade!: (value: { requestHead: string; head: string }) => void;
    let resolveClientPayload!: (value: string) => void;
    const capturedUpgrade = new Promise<{ requestHead: string; head: string }>((resolve) => {
      resolveUpgrade = resolve;
    });
    const capturedClientPayload = new Promise<string>((resolve) => {
      resolveClientPayload = resolve;
    });
    const upstream = createTcpServer((socket) => {
      upstreamSocket = socket;
      let requestBuffer = Buffer.alloc(0);
      let postUpgradeBuffer = '';
      let headersRead = false;
      socket.on('data', (chunk) => {
        if (headersRead) {
          postUpgradeBuffer += chunk.toString('utf8');
          if (postUpgradeBuffer.includes('client-post-upgrade')) {
            resolveClientPayload(postUpgradeBuffer);
          }
          return;
        }
        requestBuffer = Buffer.concat([requestBuffer, chunk]);
        const marker = requestBuffer.indexOf('\r\n\r\n');
        if (marker === -1) return;
        const bodyStart = marker + 4;
        headersRead = true;
        resolveUpgrade({
          requestHead: requestBuffer.subarray(0, bodyStart).toString('utf8'),
          head: requestBuffer.subarray(bodyStart).toString('utf8'),
        });
        socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
        setImmediate(() => socket.write('server-post-upgrade'));
      });
    });
    const upstreamPort = await listenTcp(upstream);
    const proxy = createServer();
    proxy.on('upgrade', (req, socket, head) => {
      proxyFleetTerminalStreamUpgrade(upstreamPort, req, socket, head);
    });

    try {
      const proxyPort = await listen(proxy);
      const client = connect(proxyPort, '127.0.0.1');
      try {
        await new Promise<void>((resolve) => client.once('connect', () => resolve()));
        const capturedServerPayload = new Promise<string>((resolve) => {
          let responseBuffer = '';
          client.on('data', (chunk) => {
            responseBuffer += chunk.toString('utf8');
            if (responseBuffer.includes('server-post-upgrade')) {
              resolve(responseBuffer);
            }
          });
        });
        client.write(
          'GET /api/remote-fleet/terminal/stream HTTP/1.1\r\n'
            + 'Host: 127.0.0.1\r\n'
            + 'Upgrade: websocket\r\n'
            + 'Connection: Upgrade\r\n'
            + 'Sec-WebSocket-Version: 13\r\n'
            + 'Sec-WebSocket-Key: test-key\r\n'
            + '\r\n'
            + 'client-upgrade-head',
        );

        const upgrade = await capturedUpgrade;
        expect(upgrade.requestHead).toContain('GET /api/fleet/terminal HTTP/1.1\r\n');
        expect(upgrade.requestHead).not.toContain('/api/remote-fleet/terminal/stream');
        expect(upgrade.head).toBe('client-upgrade-head');

        await expect(capturedServerPayload).resolves.toContain('server-post-upgrade');
        client.write('client-post-upgrade');
        await expect(capturedClientPayload).resolves.toContain('client-post-upgrade');
      } finally {
        client.destroy();
      }
    } finally {
      upstreamSocket?.destroy();
      await close(proxy);
      await closeTcp(upstream);
    }
  });
});

describe('Electron Main Fleet snapshot transport', () => {
  it('signs and sends the fixed snapshot read request', async () => {
    const delivery = issuer();
    const fetcher = vi.fn().mockResolvedValue({ status: 200, json: async () => snapshot });
    const transport = createFleetTransport(delivery, 34_125, fetcher);

    await expect(transport.read({
      operation: 'fleet.snapshot.get',
      input: { kind: 'snapshot' },
    })).resolves.toEqual({ status: 200, body: snapshot });

    expect(delivery.signDecision).toHaveBeenCalledWith(expect.objectContaining({
      principal: 'electron-main-local',
      endpoint: '/api/fleet',
      scope: 'fleet:read',
      capability: 'fleet.snapshot.get',
      subject: 'fleet',
      revision: '1',
    }));
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:34125/api/fleet', expect.objectContaining({
      method: 'POST',
      headers: {
        Authorization: 'Bearer signed-decision',
        'Content-Type': 'application/json',
      },
      body: '{"operation":"fleet.snapshot.get","input":{"kind":"snapshot"}}',
    }));
  });

  it('rejects unknown request fields before signing or sending', async () => {
    const delivery = issuer();
    const fetcher = vi.fn();
    const transport = createFleetTransport(delivery, 34_125, fetcher);

    await expect(transport.read({
      operation: 'fleet.snapshot.get',
      input: { kind: 'snapshot', privateField: 'secret' },
    })).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Fleet data is unavailable' },
    });
    expect(delivery.signDecision).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('accepts every sealed command target shape and nullable projection fields', async () => {
    const body = {
      ...snapshot,
      nodes: [{ ...snapshot.nodes[0], connectionId: null, environmentId: null, managedResourceId: null }],
      agents: [{ ...snapshot.agents[0], connectionId: null, environmentId: null, managedResourceId: null }],
      runtimes: [{
        ...snapshot.runtimes[0],
        connectionId: null,
        environmentId: null,
        managedResourceId: null,
        agentId: null,
        status: 'stopped',
        startedAt: null,
      }],
      endpoints: [{ ...snapshot.endpoints[0], connectionId: null, environmentId: null, managedResourceId: null }],
      commands: [
        snapshot.commands[0],
        { ...snapshot.commands[0], id: 'command-runtime', runtimeId: 'runtime-1' },
        { ...snapshot.commands[0], id: 'command-endpoint', runtimeId: 'runtime-1', endpointId: 'endpoint-1' },
      ],
      leases: [{ ...snapshot.leases[0], status: 'released', expiresAt: null }],
    } as const;
    const transport = createFleetTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_125,
      vi.fn().mockResolvedValue({ status: 200, json: async () => body }),
    );

    await expect(transport.read({
      operation: 'fleet.snapshot.get',
      input: { kind: 'snapshot' },
    })).resolves.toEqual({ status: 200, body });
  });

  it.each([
    { connections: [] },
    { nodes: [], agents: [], runtimes: [], endpoints: [] },
    { ...snapshot, privateField: 'secret' },
    { ...snapshot, connections: [{ ...snapshot.connections[0], provider: 'private' }] },
    { ...snapshot, managedResources: [{ ...snapshot.managedResources[0], provider: 'private' }] },
    { ...snapshot, sessions: [{ ...snapshot.sessions[0], targetId: 'target-1' }] },
    { ...snapshot, sessions: [{ ...snapshot.sessions[0], provider: 'ssh', generation: 1, ticket: 'secret' }] },
    { ...snapshot, auditEvents: [{ ...snapshot.auditEvents[0], id: 1 }] },
    { ...snapshot, commands: [{ ...snapshot.commands[0], runtimeId: 'runtime-1', privateField: true }] },
  ])('fails closed on malformed or private sealed snapshots', async (body) => {
    const transport = createFleetTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_125,
      vi.fn().mockResolvedValue({ status: 200, json: async () => body }),
    );

    await expect(transport.read({
      operation: 'fleet.snapshot.get',
      input: { kind: 'snapshot' },
    })).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Fleet data is unavailable' },
    });
  });

  it('accepts terminal list transport DTO and rejects private tickets', async () => {
    const request = {
      operation: 'fleet.terminals.list',
      input: { kind: 'terminalList' },
    } as const;
    const body = {
      sessions: [{
        id: 'session-1',
        targetId: 'target-1',
        provider: 'ssh',
        generation: 1,
        status: 'Connected',
        expiresAt: 'unix:3',
      }],
    } as const;
    const accepted = createFleetTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_125,
      vi.fn().mockResolvedValue({ status: 200, json: async () => body }),
    );

    await expect(accepted.read(request)).resolves.toEqual({ status: 200, body });

    const rejected = createFleetTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_125,
      vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({
          sessions: [{ ...body.sessions[0], ticket: 'private-ticket' }],
        }),
      }),
    );

    await expect(rejected.read(request)).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Fleet data is unavailable' },
    });
  });

  it('maps sealed unavailable and transport failures without leaking details', async () => {
    const unavailable = createFleetTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_125,
      vi.fn().mockResolvedValue({
        status: 503,
        json: async () => ({ success: false, error: 'private native failure' }),
      }),
    );
    const failed = createFleetTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_125,
      vi.fn().mockRejectedValue(new Error('private native token')),
    );

    const expected = {
      status: 503,
      body: { success: false, error: 'Fleet data is unavailable' },
    };
    await expect(unavailable.read({ operation: 'fleet.snapshot.get', input: { kind: 'snapshot' } })).resolves.toEqual(expected);
    const response = await failed.read({ operation: 'fleet.snapshot.get', input: { kind: 'snapshot' } });
    expect(response).toEqual(expected);
    expect(JSON.stringify(response)).not.toContain('private native');
  });
});

describe('Electron Main Fleet mutation contracts', () => {
  it.each([
    ['fleet.connections.probe.begin', 'connectionProbeBegin'],
    ['fleet.environments.deploy.begin', 'environmentDeployBegin'],
    ['fleet.environments.deploy.complete', 'environmentDeployComplete'],
    ['fleet.environments.delete.begin', 'environmentDeleteBegin'],
    ['fleet.environments.delete.complete', 'environmentDeleteComplete'],
    ['fleet.resources.provision.begin', 'resourceProvisionBegin'],
    ['fleet.resources.provision.complete', 'resourceProvisionComplete'],
    ['fleet.resources.delete.begin', 'resourceDeleteBegin'],
    ['fleet.resources.delete.complete', 'resourceDeleteComplete'],
    ['fleet.runtimes.start.begin', 'runtimeStartBegin'],
    ['fleet.runtimes.start.complete', 'runtimeStartComplete'],
    ['fleet.runtimes.stop.begin', 'runtimeStopBegin'],
    ['fleet.runtimes.stop.complete', 'runtimeStopComplete'],
    ['fleet.capabilities.sync.begin', 'capabilitySyncBegin'],
    ['fleet.endpoints.probe.begin', 'endpointProbeBegin'],
  ])('accepts Rust serde kind %s/%s', (operation, kind) => {
    const payload = operation === 'fleet.connections.probe.begin'
      || operation === 'fleet.endpoints.probe.begin'
      || operation === 'fleet.capabilities.sync.begin'
      || operation.startsWith('fleet.runtimes.')
      ? { id: 'resource-1', commandId: 'command-1' }
      : { id: 'resource-1', commandId: 'command-1', phase: 'phase-1' };
    expect(isFleetMutationRequest({ operation, input: { kind, payload } })).toBe(true);
  });

  it.each([
    ['probeNode'],
    ['installAgent'],
  ] as const)('accepts node command submit for %s', (kind) => {
    expect(isFleetMutationRequest({
      operation: 'fleet.commands.submit.node',
      input: {
        kind: 'nodeCommandSubmit',
        payload: {
          nodeId: 'node-1',
          commandId: `command-${kind}`,
          idempotencyKey: `idempotency-${kind}`,
          dispatchId: `dispatch-${kind}`,
          kind,
        },
      },
    })).toBe(true);
  });

  it('keeps connection probe completion on the fleet write scope', async () => {
    const delivery = issuer();
    const fetcher = vi.fn().mockResolvedValue({ status: 200, json: async () => ({ outcome: 'probeCompleted' }) });
    const transport = createFleetTransport(delivery, 34_125, fetcher);

    await expect(transport.mutate({
      operation: 'fleet.connections.probe.complete',
      input: {
        kind: 'connectionProbeComplete',
        payload: { id: 'connection-1', commandId: 'command-1', outcome: 'ready', message: null },
      },
    })).resolves.toEqual({ status: 200, body: { outcome: 'probeCompleted' } });
    expect(delivery.signDecision).toHaveBeenCalledWith(expect.objectContaining({ scope: 'fleet:write' }));
  });

  it.each([
    { outcome: 'probeCompleted', state: 'ready' },
    { outcome: 'probeCompleted', state: 'unhealthy' },
    { outcome: 'probeUnknown', message: 'ssh timeout' },
    { outcome: 'probeRejected', message: 'auth rejected' },
  ] as const)('accepts connection probe begin receipts with typed state/message', async (body) => {
    const transport = createFleetTransport(
      issuer(),
      34_125,
      vi.fn().mockResolvedValue({ status: 200, json: async () => body }),
    );

    await expect(transport.mutate({
      operation: 'fleet.connections.probe.begin',
      input: {
        kind: 'connectionProbeBegin',
        payload: { id: 'connection-1', commandId: 'command-1' },
      },
    })).resolves.toEqual({ status: 200, body });
  });

  it.each([
    ['fleet.runtimes.start.begin', 'runtimeStartBegin', 'runtimeLifecycleUpdated'],
    ['fleet.runtimes.stop.begin', 'runtimeStopBegin', 'runtimeLifecycleUpdated'],
    ['fleet.capabilities.sync.begin', 'capabilitySyncBegin', 'capabilitySyncStarted'],
  ] as const)('signs %s as a fleet write operation', async (operation, kind, outcome) => {
    const delivery = issuer();
    const request = {
      operation,
      input: { kind, payload: { id: 'runtime-1', commandId: 'command-1' } },
    } as const;
    const fetcher = vi.fn().mockResolvedValue({ status: 200, json: async () => ({ outcome }) });
    const transport = createFleetTransport(delivery, 34_125, fetcher);

    await expect(transport.mutate(request)).resolves.toEqual({ status: 200, body: { outcome } });
    expect(delivery.signDecision).toHaveBeenCalledWith(expect.objectContaining({
      principal: 'electron-main-local',
      endpoint: '/api/fleet',
      scope: 'fleet:write',
      capability: operation,
      subject: 'fleet',
      revision: '1',
    }));
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:34125/api/fleet', expect.objectContaining({
      method: 'POST',
      headers: {
        Authorization: 'Bearer signed-decision',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    }));
  });

  it.each([
    { outcome: 'terminalOpened', session: { id: 'session-1', nodeId: 'node-1', status: 'connected', createdAt: 'unix:1', updatedAt: 'unix:2', expiresAt: 'unix:3' }, terminalConnection: { sessionId: 'session-1', websocketPath: '/api/remote-fleet/terminal/stream', ticket: 'ticket', expiresAt: 'unix:4' } },
    { outcome: 'terminalReconnected', session: { id: 'session-1', nodeId: 'node-1', runtimeId: 'runtime-1', endpointId: 'endpoint-1', targetKind: 'ssh-host', status: 'connected', createdAt: 'unix:1', updatedAt: 'unix:3', expiresAt: 'unix:4' }, terminalConnection: { sessionId: 'session-1', websocketPath: '/api/remote-fleet/terminal/stream', ticket: 'ticket_2', expiresAt: 'unix:5' } },
  ])('accepts strict nested terminal session response %s', async (body) => {
    const request = {
      operation: body.outcome === 'terminalOpened' ? 'fleet.terminals.open' : 'fleet.terminals.reconnect',
      input: body.outcome === 'terminalOpened'
        ? { kind: 'terminalOpen', payload: { nodeId: 'node-1', size: { rows: 24, cols: 80 } } }
        : { kind: 'terminalReconnect', payload: { sessionId: 'session-1' } },
    } as const;
    const transport = createFleetTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_125,
      vi.fn().mockResolvedValue({ status: 200, json: async () => body }),
    );
    await expect(transport.mutate(request)).resolves.toEqual({ status: 200, body });
  });

  it.each([
    { outcome: 'terminalOpened', sessionId: 'session-1', generation: 1, websocketPath: '/api/fleet/terminal', ticket: 'ticket', privateField: true },
    { outcome: 'terminalReconnected', sessionId: 'session-1', generation: 0, websocketPath: '/api/fleet/terminal', ticket: 'ticket' },
    { outcome: 'terminalOpened', sessionId: 'session-1', generation: 1, websocketPath: '/api/fleet/terminal', ticket: 'not valid' },
  ])('rejects malformed terminal session response', async (body) => {
    const transport = createFleetTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_125,
      vi.fn().mockResolvedValue({ status: 200, json: async () => body }),
    );
    await expect(transport.mutate({
      operation: body.outcome === 'terminalOpened' ? 'fleet.terminals.open' : 'fleet.terminals.reconnect',
      input: body.outcome === 'terminalOpened'
        ? { kind: 'terminalOpen', payload: { nodeId: 'node-1', size: { rows: 24, cols: 80 } } }
        : { kind: 'terminalReconnect', payload: { sessionId: 'session-1' } },
    })).resolves.toEqual({ status: 503, body: { success: false, error: 'Fleet data is unavailable' } });
  });

  it('rejects the private credential mutation from the public Fleet transport', async () => {
    const delivery = issuer();
    const fetcher = vi.fn();
    const transport = createFleetTransport(delivery, 34_125, fetcher);
    await expect(transport.mutate({
      operation: 'fleet.credentials.write',
      input: { kind: 'credentialWrite', payload: {
        operationId: 'operation-1', credentialId: 'credential-1', credentialName: 'sshPassword', plaintextValue: 'secret',
      } },
    })).resolves.toEqual({ status: 503, body: { success: false, error: 'Fleet data is unavailable' } });
    expect(delivery.signDecision).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('Electron Main Fleet terminal close transport', () => {
  const request = {
    operation: 'fleet.terminals.close',
    input: {
      kind: 'terminalClose',
      payload: { sessionId: 'session-1' },
    },
  } as const;

  it.each([
    { outcome: 'terminalClosed' },
    { outcome: 'error' },
  ] as const)('sends the sealed close request and preserves %s', async (body) => {
    const delivery = issuer();
    const fetcher = vi.fn().mockResolvedValue({ status: 200, json: async () => body });
    const transport = createFleetTransport(delivery, 34_125, fetcher);

    await expect(transport.mutate(request)).resolves.toEqual({ status: 200, body });

    expect(delivery.signDecision).toHaveBeenCalledWith(expect.objectContaining({
      principal: 'electron-main-local',
      endpoint: '/api/fleet',
      scope: 'fleet:write',
      capability: 'fleet.terminals.close',
      subject: 'fleet',
      revision: '1',
    }));
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:34125/api/fleet', expect.objectContaining({
      method: 'POST',
      headers: {
        Authorization: 'Bearer signed-decision',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    }));
  });

  it('rejects a reason field before signing or sending', async () => {
    const delivery = issuer();
    const fetcher = vi.fn();
    const transport = createFleetTransport(delivery, 34_125, fetcher);

    await expect(transport.mutate({
      ...request,
      input: {
        ...request.input,
        payload: { sessionId: 'session-1', reason: 'done' },
      },
    })).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Fleet data is unavailable' },
    });
    expect(delivery.signDecision).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { outcome: 'terminalClosed', privateField: true },
    { outcome: 'closed' },
    { outcome: 'error', message: 'native detail' },
  ])('fails closed on malformed close responses', async (body) => {
    const transport = createFleetTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_125,
      vi.fn().mockResolvedValue({ status: 200, json: async () => body }),
    );

    await expect(transport.mutate(request)).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Fleet data is unavailable' },
    });
  });

  it('maps close unavailable and transport errors without leaking details', async () => {
    const unavailable = createFleetTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_125,
      vi.fn().mockResolvedValue({ status: 503, json: async () => ({ success: false, error: 'private native failure' }) }),
    );
    const failed = createFleetTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_125,
      vi.fn().mockRejectedValue(new Error('private native token')),
    );
    const expected = {
      status: 503,
      body: { success: false, error: 'Fleet data is unavailable' },
    };

    await expect(unavailable.mutate(request)).resolves.toEqual(expected);
    const response = await failed.mutate(request);
    expect(response).toEqual(expected);
    expect(JSON.stringify(response)).not.toContain('private native');
  });
});
