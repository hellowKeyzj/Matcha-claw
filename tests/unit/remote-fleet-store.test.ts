import { beforeEach, describe, expect, it, vi } from 'vitest';

const hostApiFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
}));

describe('remote fleet store', () => {
  beforeEach(() => {
    vi.resetModules();
    hostApiFetchMock.mockReset();
  });

  it('classifies command outcomes from command statuses', async () => {
    const { remoteFleetCommandOutcome } = await import('@/stores/remote-fleet');
    const commandOutcomes = [
      [{ status: 'succeeded' }, 'succeeded'],
      [{ status: 'queued' }, 'pending'],
      [{ status: 'running' }, 'pending'],
      [{ status: 'failed' }, 'failed'],
      [{ status: 'cancelled' }, 'failed'],
      [{ status: 'timed-out' }, 'failed'],
      [undefined, 'missing'],
      [{ status: 'unknown' }, 'missing'],
    ] as const;

    for (const [command, expectedOutcome] of commandOutcomes) {
      expect(remoteFleetCommandOutcome(command)).toBe(expectedOutcome);
    }
  });

  it('refresh updates Remote Fleet projection slices and ready state through runtime-host route', async () => {
    const snapshotProjection = {
      connections: [{ id: 'connection-1', displayName: 'Connection 1', connectionKind: 'ssh-host', status: 'online' }],
      environments: [
        {
          id: 'environment-1',
          connectionId: 'connection-1',
          nodeId: 'node-1',
          displayName: 'Environment 1',
          environmentKind: 'docker-container',
          targetKind: 'container',
          status: 'ready',
          labels: ['dev'],
          enabled: true,
          managedResourceIds: ['managed-resource-1'],
          secret: 'environment-secret',
          token: 'environment-token',
          ticket: 'environment-ticket',
          stdout: 'environment stdout',
          stderr: 'environment stderr',
        },
      ],
      managedResources: [
        {
          id: 'managed-resource-1',
          connectionId: 'connection-1',
          environmentId: 'environment-1',
          nodeId: 'node-1',
          providerKind: 'docker',
          resourceKind: 'docker-container',
          remoteResourceId: 'container-1',
          displayName: 'Container 1',
          status: 'ready',
          ownership: 'matcha-managed',
          cleanupPolicy: 'delete-on-environment-delete',
          labels: ['dev'],
          password: 'managed-resource-password',
          authorization: 'Bearer managed-resource-secret',
          logs: ['managed resource log'],
        },
      ],
      nodes: [{ id: 'node-1', connectionId: 'connection-1', environmentId: 'environment-1', managedResourceId: 'managed-resource-1', displayName: 'Node 1', status: 'online' }],
      agents: [{ id: 'agent-1', connectionId: 'connection-1', environmentId: 'environment-1', managedResourceId: 'managed-resource-1', nodeId: 'node-1', status: 'enrolled' }],
      runtimes: [{ id: 'runtime-1', connectionId: 'connection-1', environmentId: 'environment-1', managedResourceId: 'managed-resource-1', nodeId: 'node-1', agentId: 'agent-1', status: 'running' }],
      endpoints: [{ id: 'endpoint-1', connectionId: 'connection-1', environmentId: 'environment-1', managedResourceId: 'managed-resource-1', nodeId: 'node-1', runtimeId: 'runtime-1', status: 'ready' }],
      capabilities: [
        {
          id: 'capability-1',
          nodeId: 'node-1',
          runtimeId: 'runtime-1',
          endpointId: 'endpoint-1',
          operationIds: ['remoteFleet.runtime.start'],
          status: 'current',
        },
      ],
      commands: [
        {
          id: 'command-1',
          runtimeId: 'runtime-1',
          command: 'remoteFleet.runtime.start',
          status: 'succeeded',
        },
      ],
      leases: [
        {
          id: 'lease-1',
          endpointId: 'endpoint-1',
          ownerKind: 'runtime',
          ownerId: 'runtime-1',
          status: 'active',
        },
      ],
      sessions: [
        {
          id: 'session-1',
          nodeId: 'node-1',
          runtimeId: 'runtime-1',
          endpointId: 'endpoint-1',
          targetKind: 'ssh-host',
          status: 'connected',
          ticket: 'snapshot-ticket-secret',
          stdout: 'raw stdout',
          stderr: 'raw stderr',
          logs: ['raw log'],
          authorization: 'Bearer secret',
        },
      ],
      auditEvents: [
        {
          id: 'audit-1',
          eventName: 'remoteFleet.command.succeeded',
          commandId: 'command-1',
          occurredAt: '2026-01-01T00:01:00.000Z',
        },
      ],
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    hostApiFetchMock.mockResolvedValueOnce(snapshotProjection);

    const { useRemoteFleetStore } = await import('@/stores/remote-fleet');
    await useRemoteFleetStore.getState().refresh();

    const state = useRemoteFleetStore.getState();
    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/remote-fleet/snapshot');
    expect(state.connections).toEqual([
      { id: 'connection-1', displayName: 'Connection 1', connectionKind: 'ssh-host', targetKind: 'ssh-host', status: 'online' },
    ]);
    expect(state.environments).toEqual([
      {
        id: 'environment-1',
        connectionId: 'connection-1',
        nodeId: 'node-1',
        displayName: 'Environment 1',
        environmentKind: 'docker-container',
        targetKind: 'container',
        status: 'ready',
        labels: ['dev'],
        enabled: true,
        managedResourceIds: ['managed-resource-1'],
      },
    ]);
    expect(state.managedResources).toEqual([
      {
        id: 'managed-resource-1',
        connectionId: 'connection-1',
        environmentId: 'environment-1',
        nodeId: 'node-1',
        providerKind: 'docker',
        resourceKind: 'docker-container',
        remoteResourceId: 'container-1',
        displayName: 'Container 1',
        status: 'ready',
        ownership: 'matcha-managed',
        cleanupPolicy: 'delete-on-environment-delete',
        labels: ['dev'],
      },
    ]);
    expect(state.nodes).toEqual(snapshotProjection.nodes);
    expect(state.agents).toEqual(snapshotProjection.agents);
    expect(state.runtimes).toEqual(snapshotProjection.runtimes);
    expect(state.endpoints).toEqual(snapshotProjection.endpoints);
    expect(state.capabilities).toEqual(snapshotProjection.capabilities);
    expect(state.commands).toEqual(snapshotProjection.commands);
    expect(state.leases).toEqual(snapshotProjection.leases);
    expect(state.sessions).toEqual([
      {
        id: 'session-1',
        nodeId: 'node-1',
        runtimeId: 'runtime-1',
        endpointId: 'endpoint-1',
        targetKind: 'ssh-host',
        status: 'connected',
      },
    ]);
    expect(JSON.stringify(state)).not.toContain('environment-secret');
    expect(JSON.stringify(state)).not.toContain('environment-token');
    expect(JSON.stringify(state)).not.toContain('environment-ticket');
    expect(JSON.stringify(state)).not.toContain('environment stdout');
    expect(JSON.stringify(state)).not.toContain('environment stderr');
    expect(JSON.stringify(state)).not.toContain('managed-resource-password');
    expect(JSON.stringify(state)).not.toContain('Bearer managed-resource-secret');
    expect(JSON.stringify(state)).not.toContain('managed resource log');
    expect(JSON.stringify(state.sessions)).not.toContain('snapshot-ticket-secret');
    expect(JSON.stringify(state.sessions)).not.toContain('raw stdout');
    expect(JSON.stringify(state.sessions)).not.toContain('raw stderr');
    expect(JSON.stringify(state.sessions)).not.toContain('Bearer secret');
    expect(state.auditEvents).toEqual(snapshotProjection.auditEvents);
    expect(state.ready).toBe(true);
    expect(state.loading).toBe(false);
  });

  it('registers provider-target node DTO with publicConfig and secretRefs only', async () => {
    hostApiFetchMock.mockResolvedValueOnce({
      node: { id: 'node-ssh-1', status: 'unknown' },
    });

    const { useRemoteFleetStore } = await import('@/stores/remote-fleet');
    await useRemoteFleetStore.getState().register({
      id: 'node-ssh-1',
      displayName: 'SSH node',
      targetKind: 'ssh-host',
      endpointUrl: 'ssh://lab-linux-01.internal:22',
      labels: ['linux'],
      enabled: true,
      publicConfig: {
        ssh: {
          host: 'lab-linux-01.internal',
          port: 22,
          username: 'matcha',
          installCommand: 'curl -fsSL https://fleet.example/install.sh | sh',
        },
      },
      secretRefs: {
        sshPrivateKey: { kind: 'secret-ref', ref: 'remote-fleet://node-ssh-1/ssh-private-key' },
      },
    });

    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/remote-fleet/register', {
      method: 'POST',
      body: JSON.stringify({
        node: {
          id: 'node-ssh-1',
          displayName: 'SSH node',
          targetKind: 'ssh-host',
          endpointUrl: 'ssh://lab-linux-01.internal:22',
          labels: ['linux'],
          enabled: true,
          publicConfig: {
            ssh: {
              host: 'lab-linux-01.internal',
              port: 22,
              username: 'matcha',
              installCommand: 'curl -fsSL https://fleet.example/install.sh | sh',
            },
          },
          secretRefs: {
            sshPrivateKey: { kind: 'secret-ref', ref: 'remote-fleet://node-ssh-1/ssh-private-key' },
          },
        },
      }),
    });
    const calledPaths = hostApiFetchMock.mock.calls.map(([path]) => path);
    expect(calledPaths).toEqual(['/api/remote-fleet/register']);
    expect(calledPaths).not.toContain('/api/remote-fleet/issue-enrollment-token');
    expect(calledPaths).not.toContain('ssh://lab-linux-01.internal:22');
    expect(JSON.stringify(hostApiFetchMock.mock.calls)).not.toContain('BEGIN OPENSSH PRIVATE KEY');
    expect(JSON.stringify(useRemoteFleetStore.getState())).not.toContain('BEGIN OPENSSH PRIVATE KEY');
  });

  it('registers, deploys, and deletes environments through resource-model routes', async () => {
    hostApiFetchMock
      .mockResolvedValueOnce({
        environment: {
          id: 'environment-1',
          connectionId: 'connection-1',
          nodeId: 'node-1',
          displayName: 'Environment 1',
          environmentKind: 'docker-container',
          targetKind: 'container',
          status: 'registered',
          labels: ['dev'],
          enabled: true,
          managedResourceIds: [],
          environmentSecret: 'environment-secret',
        },
      })
      .mockResolvedValueOnce({
        environments: [
          {
            id: 'environment-1',
            connectionId: 'connection-1',
            displayName: 'Environment 1',
            environmentKind: 'docker-container',
            targetKind: 'container',
            status: 'ready',
            managedResourceIds: ['managed-resource-1'],
            token: 'deploy-token',
          },
        ],
        managedResources: [
          {
            id: 'managed-resource-1',
            connectionId: 'connection-1',
            environmentId: 'environment-1',
            providerKind: 'docker',
            resourceKind: 'docker-container',
            remoteResourceId: 'container-1',
            displayName: 'Container 1',
            status: 'ready',
            ownership: 'matcha-managed',
            cleanupPolicy: 'delete-on-environment-delete',
            authorization: 'Bearer deploy-secret',
          },
        ],
        command: { id: 'command-1', environmentId: 'environment-1', command: 'deploy-environment', status: 'succeeded' },
      })
      .mockResolvedValueOnce({
        environment: {
          id: 'environment-1',
          connectionId: 'connection-1',
          displayName: 'Environment 1',
          environmentKind: 'docker-container',
          targetKind: 'container',
          status: 'deleted',
          managedResourceIds: ['managed-resource-1'],
        },
        managedResource: {
          id: 'managed-resource-1',
          connectionId: 'connection-1',
          environmentId: 'environment-1',
          providerKind: 'docker',
          resourceKind: 'docker-container',
          remoteResourceId: 'container-1',
          displayName: 'Container 1',
          status: 'deleted',
          ownership: 'matcha-managed',
          cleanupPolicy: 'delete-on-environment-delete',
        },
      });

    const { useRemoteFleetStore } = await import('@/stores/remote-fleet');
    await useRemoteFleetStore.getState().registerEnvironment({
      id: 'environment-1',
      connectionId: 'connection-1',
      nodeId: 'node-1',
      displayName: 'Environment 1',
      environmentKind: 'docker-container',
      targetKind: 'container',
      labels: ['dev'],
      enabled: true,
      publicConfig: { image: 'ubuntu:latest' },
      secretRefs: { dockerRegistryToken: { kind: 'secret-ref', ref: 'remote-fleet://credentials/docker-registry-token' } },
    });
    await useRemoteFleetStore.getState().deployEnvironment('environment-1');
    await useRemoteFleetStore.getState().deleteEnvironment('environment-1');

    expect(hostApiFetchMock).toHaveBeenNthCalledWith(1, '/api/remote-fleet/register-environment', {
      method: 'POST',
      body: JSON.stringify({
        environment: {
          id: 'environment-1',
          connectionId: 'connection-1',
          nodeId: 'node-1',
          displayName: 'Environment 1',
          environmentKind: 'docker-container',
          targetKind: 'container',
          labels: ['dev'],
          enabled: true,
          publicConfig: { image: 'ubuntu:latest' },
          secretRefs: { dockerRegistryToken: { kind: 'secret-ref', ref: 'remote-fleet://credentials/docker-registry-token' } },
        },
      }),
    });
    expect(hostApiFetchMock).toHaveBeenNthCalledWith(2, '/api/remote-fleet/deploy-environment', {
      method: 'POST',
      body: JSON.stringify({ environmentId: 'environment-1' }),
      timeoutMs: 900_000,
    });
    expect(hostApiFetchMock).toHaveBeenNthCalledWith(3, '/api/remote-fleet/delete-environment', {
      method: 'POST',
      body: JSON.stringify({ environmentId: 'environment-1' }),
    });
    expect(useRemoteFleetStore.getState().environments).toEqual([
      {
        id: 'environment-1',
        connectionId: 'connection-1',
        displayName: 'Environment 1',
        environmentKind: 'docker-container',
        targetKind: 'container',
        status: 'deleted',
        managedResourceIds: ['managed-resource-1'],
      },
    ]);
    expect(useRemoteFleetStore.getState().managedResources).toEqual([
      {
        id: 'managed-resource-1',
        connectionId: 'connection-1',
        environmentId: 'environment-1',
        providerKind: 'docker',
        resourceKind: 'docker-container',
        remoteResourceId: 'container-1',
        displayName: 'Container 1',
        status: 'deleted',
        ownership: 'matcha-managed',
        cleanupPolicy: 'delete-on-environment-delete',
      },
    ]);
    expect(useRemoteFleetStore.getState().commands).toEqual([
      { id: 'command-1', environmentId: 'environment-1', command: 'deploy-environment', status: 'succeeded' },
    ]);
    expect(JSON.stringify(useRemoteFleetStore.getState())).not.toContain('environment-secret');
    expect(JSON.stringify(useRemoteFleetStore.getState())).not.toContain('deploy-token');
    expect(JSON.stringify(useRemoteFleetStore.getState())).not.toContain('Bearer deploy-secret');
    expect(useRemoteFleetStore.getState().mutatingAction).toBeNull();
  });

  it('patches only slices present in action snapshots', async () => {
    hostApiFetchMock
      .mockResolvedValueOnce({
        connections: [{ id: 'connection-1', displayName: 'Connection 1', connectionKind: 'ssh-host', status: 'online' }],
        environments: [
          { id: 'environment-1', connectionId: 'connection-1', displayName: 'Environment 1', environmentKind: 'docker-container', targetKind: 'container', status: 'registered', managedResourceIds: [] },
        ],
        managedResources: [],
        nodes: [{ id: 'node-1', connectionId: 'connection-1', environmentId: 'environment-1', status: 'online' }],
        agents: [],
        runtimes: [],
        endpoints: [],
        capabilities: [],
        commands: [],
        leases: [],
        sessions: [],
        auditEvents: [],
      })
      .mockResolvedValueOnce({
        snapshot: {
          environments: [
            { id: 'environment-1', connectionId: 'connection-1', displayName: 'Environment 1', environmentKind: 'docker-container', targetKind: 'container', status: 'ready', managedResourceIds: [] },
          ],
        },
      });

    const { useRemoteFleetStore } = await import('@/stores/remote-fleet');
    await useRemoteFleetStore.getState().refresh();
    await useRemoteFleetStore.getState().deployEnvironment('environment-1');

    const state = useRemoteFleetStore.getState();
    expect(state.environments).toEqual([
      { id: 'environment-1', connectionId: 'connection-1', displayName: 'Environment 1', environmentKind: 'docker-container', targetKind: 'container', status: 'ready', managedResourceIds: [] },
    ]);
    expect(state.connections).toEqual([
      { id: 'connection-1', displayName: 'Connection 1', connectionKind: 'ssh-host', targetKind: 'ssh-host', status: 'online' },
    ]);
    expect(state.nodes).toEqual([{ id: 'node-1', connectionId: 'connection-1', environmentId: 'environment-1', status: 'online' }]);
    expect(state.ready).toBe(true);
  });

  it('writes credentials through the dedicated route without storing plaintext or operation metadata in Zustand state', async () => {
    const operationId = 'f17d29c8-0c58-4375-9aa6-687d1cc4d0f4';
    hostApiFetchMock.mockResolvedValueOnce({
      credentialName: 'sshPassword',
      credentialRef: { kind: 'secret-ref', ref: 'remote-fleet://credentials/node-ssh-1/sshPassword' },
    });

    const { useRemoteFleetStore } = await import('@/stores/remote-fleet');
    const result = await useRemoteFleetStore.getState().writeCredential({
      operationId,
      credentialId: 'node-ssh-1',
      credentialName: 'sshPassword',
      plaintextValue: 'ssh-secret-password',
    });

    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/remote-fleet/write-credential', {
      method: 'POST',
      body: JSON.stringify({
        operationId,
        credentialId: 'node-ssh-1',
        credentialName: 'sshPassword',
        plaintextValue: 'ssh-secret-password',
      }),
    });
    expect(JSON.parse(String(hostApiFetchMock.mock.calls[0]?.[1]?.body))).toEqual(expect.objectContaining({
      operationId: expect.any(String),
    }));
    expect(result).toEqual({
      credentialName: 'sshPassword',
      credentialRef: { kind: 'secret-ref', ref: 'remote-fleet://credentials/node-ssh-1/sshPassword' },
    });
    expect(JSON.stringify(result)).not.toContain('ssh-secret-password');
    expect(JSON.stringify(result)).not.toContain(operationId);
    expect(JSON.stringify(useRemoteFleetStore.getState())).not.toContain('ssh-secret-password');
    expect(JSON.stringify(useRemoteFleetStore.getState())).not.toContain(operationId);
    expect(useRemoteFleetStore.getState().mutatingAction).toBeNull();
  });

  it('checks a connection through its dedicated route and applies only the canonical snapshot', async () => {
    hostApiFetchMock.mockResolvedValueOnce({
      snapshot: {
        connections: [{
          id: 'connection-1',
          displayName: 'Docker connection',
          connectionKind: 'container',
          targetKind: 'container',
          status: 'online',
          lastSeenAt: '2026-07-06T00:00:00.000Z',
        }],
        environments: [],
        managedResources: [],
        nodes: [],
        agents: [],
        runtimes: [],
        endpoints: [],
        capabilities: [],
        commands: [{ id: 'cmd-connection-probe', connectionId: 'connection-1', command: 'probe-connection', status: 'succeeded' }],
        leases: [],
        sessions: [],
        auditEvents: [],
      },
      connection: {
        id: 'connection-1',
        status: 'online',
        token: 'connection-probe-token',
      },
    });

    const { useRemoteFleetStore } = await import('@/stores/remote-fleet');
    const payload = await useRemoteFleetStore.getState().probeConnection('connection-1');
    const state = useRemoteFleetStore.getState();

    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/remote-fleet/probe-connection', {
      method: 'POST',
      body: JSON.stringify({ connectionId: 'connection-1' }),
    });
    expect(payload.snapshot?.connections).toContainEqual(expect.objectContaining({
      id: 'connection-1',
      status: 'online',
    }));
    expect(state.connections).toContainEqual(expect.objectContaining({
      id: 'connection-1',
      status: 'online',
    }));
    expect(JSON.stringify(payload)).not.toContain('connection-probe-token');
    expect(JSON.stringify(state)).not.toContain('connection-probe-token');
    expect(state.mutatingAction).toBeNull();
  });

  it('deletes a connection through its canonical snapshot patch without leaking sensitive fields', async () => {
    const canonicalProjection = {
      connections: [{ id: 'connection-2', displayName: 'Surviving connection', connectionKind: 'container', targetKind: 'container', status: 'online' }],
      environments: [{ id: 'environment-2', connectionId: 'connection-2', displayName: 'Environment 2', environmentKind: 'docker-container', targetKind: 'container', status: 'ready', managedResourceIds: ['managed-resource-2'] }],
      managedResources: [{ id: 'managed-resource-2', connectionId: 'connection-2', environmentId: 'environment-2', providerKind: 'docker', resourceKind: 'docker-container', status: 'ready' }],
      nodes: [{ id: 'node-2', connectionId: 'connection-2', environmentId: 'environment-2', status: 'online' }],
      agents: [{ id: 'agent-2', connectionId: 'connection-2', nodeId: 'node-2', status: 'enrolled' }],
      runtimes: [{ id: 'runtime-2', connectionId: 'connection-2', nodeId: 'node-2', agentId: 'agent-2', status: 'running' }],
      endpoints: [{ id: 'endpoint-2', connectionId: 'connection-2', nodeId: 'node-2', runtimeId: 'runtime-2', status: 'ready' }],
      capabilities: [{ id: 'capability-2', connectionId: 'connection-2', nodeId: 'node-2', runtimeId: 'runtime-2', endpointId: 'endpoint-2', status: 'current' }],
      commands: [{ id: 'command-2', connectionId: 'connection-2', command: 'delete-connection', status: 'succeeded' }],
      leases: [{ id: 'lease-2', endpointId: 'endpoint-2', status: 'active' }],
      sessions: [{ id: 'session-2', nodeId: 'node-2', runtimeId: 'runtime-2', endpointId: 'endpoint-2', status: 'connected' }],
      auditEvents: [{ id: 'audit-2', eventName: 'remoteFleet.connection.deleted', occurredAt: '2026-07-12T00:00:00.000Z' }],
    };
    const canonicalSnapshot = {
      connections: canonicalProjection.connections.map((connection) => ({ ...connection, token: 'connection-token' })),
      environments: canonicalProjection.environments.map((environment) => ({ ...environment, secret: 'environment-secret' })),
      managedResources: canonicalProjection.managedResources.map((managedResource) => ({ ...managedResource, password: 'managed-resource-password' })),
      nodes: canonicalProjection.nodes.map((node) => ({ ...node, authorization: 'Bearer node-secret' })),
      agents: canonicalProjection.agents.map((agent) => ({ ...agent, token: 'agent-token' })),
      runtimes: canonicalProjection.runtimes.map((runtime) => ({ ...runtime, secret: 'runtime-secret' })),
      endpoints: canonicalProjection.endpoints.map((endpoint) => ({ ...endpoint, ticket: 'endpoint-ticket' })),
      capabilities: canonicalProjection.capabilities.map((capability) => ({ ...capability, authorization: 'Bearer capability-secret' })),
      commands: canonicalProjection.commands.map((command) => ({ ...command, token: 'command-token' })),
      leases: canonicalProjection.leases.map((lease) => ({ ...lease, password: 'lease-password' })),
      sessions: canonicalProjection.sessions.map((session) => ({ ...session, ticket: 'session-ticket' })),
      auditEvents: canonicalProjection.auditEvents.map((auditEvent) => ({ ...auditEvent, secret: 'audit-secret' })),
    };

    const { useRemoteFleetStore } = await import('@/stores/remote-fleet');
    useRemoteFleetStore.setState({
      connections: [
        { id: 'connection-1', displayName: 'Deleted connection', connectionKind: 'ssh-host', targetKind: 'ssh-host', status: 'online' },
        { id: 'connection-2', displayName: 'Stale surviving connection', connectionKind: 'container', targetKind: 'container', status: 'offline' },
      ],
      environments: [{ id: 'stale-environment', connectionId: 'connection-1' }],
      managedResources: [{ id: 'stale-managed-resource', connectionId: 'connection-1', environmentId: 'stale-environment' }],
      nodes: [{ id: 'stale-node', connectionId: 'connection-1' }],
      agents: [{ id: 'stale-agent', connectionId: 'connection-1' }],
      runtimes: [{ id: 'stale-runtime', connectionId: 'connection-1' }],
      endpoints: [{ id: 'stale-endpoint', connectionId: 'connection-1' }],
      capabilities: [{ id: 'stale-capability', connectionId: 'connection-1' }],
      commands: [{ id: 'stale-command', connectionId: 'connection-1' }],
      leases: [{ id: 'stale-lease' }],
      sessions: [{ id: 'stale-session', nodeId: 'stale-node' }],
      auditEvents: [{ id: 'stale-audit-event' }],
    });
    hostApiFetchMock.mockImplementationOnce(async () => {
      expect(useRemoteFleetStore.getState().mutatingAction).toBe('delete-connection:connection-1');
      return { snapshot: canonicalSnapshot };
    });

    const payload = await useRemoteFleetStore.getState().deleteConnection('connection-1');
    const state = useRemoteFleetStore.getState();
    const stateProjection = {
      connections: state.connections,
      environments: state.environments,
      managedResources: state.managedResources,
      nodes: state.nodes,
      agents: state.agents,
      runtimes: state.runtimes,
      endpoints: state.endpoints,
      capabilities: state.capabilities,
      commands: state.commands,
      leases: state.leases,
      sessions: state.sessions,
      auditEvents: state.auditEvents,
    };

    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/remote-fleet/delete-connection', {
      method: 'POST',
      body: JSON.stringify({ connectionId: 'connection-1' }),
    });
    expect(payload.snapshot).toEqual(canonicalProjection);
    expect(stateProjection).toEqual(canonicalProjection);
    expect(state.connections).not.toContainEqual(expect.objectContaining({ id: 'connection-1' }));
    expect(state.ready).toBe(true);
    expect(state.mutatingAction).toBeNull();

    for (const sensitiveValue of [
      'connection-token',
      'environment-secret',
      'managed-resource-password',
      'Bearer node-secret',
      'agent-token',
      'runtime-secret',
      'endpoint-ticket',
      'Bearer capability-secret',
      'command-token',
      'lease-password',
      'session-ticket',
      'audit-secret',
    ]) {
      expect(JSON.stringify(payload)).not.toContain(sensitiveValue);
      expect(JSON.stringify(state)).not.toContain(sensitiveValue);
    }
  });

  it('does not expose public enrollment token actions or state while retaining agent lifecycle actions', async () => {
    const { useRemoteFleetStore } = await import('@/stores/remote-fleet');
    const state = useRemoteFleetStore.getState();

    expect(state).not.toHaveProperty('issueEnrollmentToken');
    expect(state).not.toHaveProperty('enrollmentToken');
    expect(state).toHaveProperty('install');
    expect(state).toHaveProperty('revoke');
    expect(typeof state.install).toBe('function');
    expect(typeof state.revoke).toBe('function');
  });

  it('loadMetrics only updates metrics and leaves ready false when snapshot is not loaded', async () => {
    const metricsProjection = {
      nodes: {
        totalCount: 1,
        countByStatus: { online: 1 },
        countByTargetKind: { 'ssh-host': 1 },
      },
      agents: {
        totalCount: 1,
        countByStatus: { enrolled: 1 },
      },
      runtimes: {
        totalCount: 1,
        countByStatus: { running: 1 },
        countByRuntimeKind: { openclaw: 1 },
      },
      endpoints: {
        totalCount: 1,
        countByStatus: { ready: 1 },
        drainingEndpoints: [],
        retiredEndpoints: [],
      },
      capabilities: {
        totalCount: 1,
        countByStatus: { current: 1 },
        staleCount: 0,
      },
      commands: {
        totalCount: 1,
        countByStatus: { queued: 1 },
        recentFailureCount: 0,
      },
      leases: {
        totalCount: 1,
        countByStatus: { active: 1 },
        activeCount: 1,
      },
      auditEvents: {
        totalCount: 1,
        countByEventName: { 'remoteFleet.command.queued': 1 },
      },
    };
    hostApiFetchMock.mockResolvedValueOnce(metricsProjection);

    const { useRemoteFleetStore } = await import('@/stores/remote-fleet');
    const metrics = await useRemoteFleetStore.getState().loadMetrics();
    const state = useRemoteFleetStore.getState();

    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/remote-fleet/metrics');
    expect(hostApiFetchMock.mock.calls.map(([path]) => path)).not.toContain('/api/remote-fleet/start');
    expect(hostApiFetchMock.mock.calls.map(([path]) => path)).not.toContain('/api/remote-fleet/stop');
    expect(hostApiFetchMock.mock.calls.map(([path]) => path)).not.toContain('/api/remote-fleet/sync');
    expect(metrics).toEqual(metricsProjection);
    expect(state.metrics).toEqual(metricsProjection);
    expect(state.nodes).toEqual([]);
    expect(state.agents).toEqual([]);
    expect(state.runtimes).toEqual([]);
    expect(state.endpoints).toEqual([]);
    expect(state.capabilities).toEqual([]);
    expect(state.commands).toEqual([]);
    expect(state.leases).toEqual([]);
    expect(state.auditEvents).toEqual([]);
    expect(state.ready).toBe(false);
    expect(state.mutatingAction).toBeNull();
  });

  it('drops sensitive command fields from refreshed command slice', async () => {
    hostApiFetchMock.mockResolvedValueOnce({
      nodes: [],
      agents: [],
      runtimes: [],
      endpoints: [],
      capabilities: [],
      commands: [
        {
          id: 'command-1',
          nodeId: 'node-1',
          command: 'remoteFleet.capabilities.sync',
          status: 'queued',
          idempotencyKey: 'idem-secret',
          token: 'command-token',
          secret: 'command-secret',
        },
      ],
      leases: [],
      sessions: [],
      auditEvents: [],
    });

    const { useRemoteFleetStore } = await import('@/stores/remote-fleet');
    await useRemoteFleetStore.getState().refresh();

    const state = useRemoteFleetStore.getState();
    expect(state.commands).toEqual([
      {
        id: 'command-1',
        nodeId: 'node-1',
        command: 'remoteFleet.capabilities.sync',
        status: 'queued',
      },
    ]);
    expect(JSON.stringify(state.commands)).not.toContain('idem-secret');
    expect(JSON.stringify(state.commands)).not.toContain('command-token');
    expect(JSON.stringify(state.commands)).not.toContain('command-secret');
  });

  it('uses an extended timeout for Remote Fleet install and environment deploy commands', async () => {
    hostApiFetchMock.mockResolvedValueOnce({
      command: { id: 'command-1', nodeId: 'node-1', command: 'install-agent', status: 'succeeded' },
    });

    const { useRemoteFleetStore } = await import('@/stores/remote-fleet');
    await useRemoteFleetStore.getState().install('node-1');

    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/remote-fleet/install-agent', {
      method: 'POST',
      body: JSON.stringify({ nodeId: 'node-1' }),
      timeoutMs: 900_000,
    });
    expect(useRemoteFleetStore.getState().commands).toEqual([
      { id: 'command-1', nodeId: 'node-1', command: 'install-agent', status: 'succeeded' },
    ]);
    expect(useRemoteFleetStore.getState().mutatingAction).toBeNull();
  });

  it('starts runtime through capability execute', async () => {
    hostApiFetchMock.mockResolvedValueOnce({
      runtime: { id: 'runtime-1', status: 'starting' },
    });

    const { useRemoteFleetStore } = await import('@/stores/remote-fleet');
    await useRemoteFleetStore.getState().start({ id: 'runtime-1', nodeId: 'node-1' });

    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/capabilities/execute', {
      method: 'POST',
      body: JSON.stringify({
        id: 'remote-fleet.runtime-control',
        operationId: 'remoteFleet.runtime.start',
        scope: {
          kind: 'runtime-instance',
          endpoint: {
            kind: 'native-runtime',
            runtimeAdapterId: 'remote-fleet',
            runtimeInstanceId: 'runtime-1',
          },
        },
        target: { kind: 'runtime-endpoint' },
        input: {},
      }),
    });
    expect(hostApiFetchMock).not.toHaveBeenCalledWith('/api/remote-fleet/start', expect.anything());
    expect(useRemoteFleetStore.getState().runtimes).toEqual([{ id: 'runtime-1', status: 'starting' }]);
    expect(useRemoteFleetStore.getState().mutatingAction).toBeNull();
  });

  it('stops runtime through capability execute', async () => {
    hostApiFetchMock.mockResolvedValueOnce({
      runtime: { id: 'runtime-1', status: 'stopping' },
    });

    const { useRemoteFleetStore } = await import('@/stores/remote-fleet');
    await useRemoteFleetStore.getState().stop({ id: 'runtime-1', nodeId: 'node-1' });

    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/capabilities/execute', {
      method: 'POST',
      body: JSON.stringify({
        id: 'remote-fleet.runtime-control',
        operationId: 'remoteFleet.runtime.stop',
        scope: {
          kind: 'runtime-instance',
          endpoint: {
            kind: 'native-runtime',
            runtimeAdapterId: 'remote-fleet',
            runtimeInstanceId: 'runtime-1',
          },
        },
        target: { kind: 'runtime-endpoint' },
        input: {},
      }),
    });
    expect(hostApiFetchMock).not.toHaveBeenCalledWith('/api/remote-fleet/stop', expect.anything());
    expect(useRemoteFleetStore.getState().runtimes).toEqual([{ id: 'runtime-1', status: 'stopping' }]);
    expect(useRemoteFleetStore.getState().mutatingAction).toBeNull();
  });

  it('syncs endpoint capabilities through capability execute', async () => {
    hostApiFetchMock.mockResolvedValueOnce({
      capability: { id: 'capability-1', endpointId: 'endpoint-1', status: 'syncing' },
    });

    const { useRemoteFleetStore } = await import('@/stores/remote-fleet');
    await useRemoteFleetStore.getState().sync({ id: 'endpoint-1', runtimeId: 'runtime-1', nodeId: 'node-1' });

    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/capabilities/execute', {
      method: 'POST',
      body: JSON.stringify({
        id: 'remote-fleet.runtime-control',
        operationId: 'remoteFleet.capabilities.sync',
        scope: {
          kind: 'runtime-instance',
          endpoint: {
            kind: 'native-runtime',
            runtimeAdapterId: 'remote-fleet',
            runtimeInstanceId: 'runtime-1',
          },
        },
        target: { kind: 'runtime-endpoint' },
        input: {},
      }),
    });
    expect(hostApiFetchMock).not.toHaveBeenCalledWith('/api/remote-fleet/sync', expect.anything());
    expect(useRemoteFleetStore.getState().capabilities).toEqual([
      { id: 'capability-1', endpointId: 'endpoint-1', status: 'syncing' },
    ]);
    expect(useRemoteFleetStore.getState().mutatingAction).toBeNull();
  });

  it('opens terminal through runtime-host route without storing the connection ticket', async () => {
    hostApiFetchMock.mockResolvedValueOnce({
      session: {
        id: 'terminal-session-1',
        nodeId: 'node-1',
        runtimeId: 'runtime-1',
        endpointId: 'endpoint-1',
        targetKind: 'ssh-host',
        status: 'connected',
        token: 'session-token-secret',
        stdout: 'raw stdout',
      },
      terminalConnection: {
        sessionId: 'terminal-session-1',
        ticket: 'terminal-ticket-secret',
        websocketPath: '/api/remote-fleet/terminal/stream?sessionId=terminal-session-1&ticket=terminal-ticket-secret',
        expiresAt: '2026-07-08T00:00:30.000Z',
      },
    });

    const { useRemoteFleetStore } = await import('@/stores/remote-fleet');
    const result = await useRemoteFleetStore.getState().openTerminal({ endpointId: 'endpoint-1', size: { rows: 30, cols: 100 } });
    const state = useRemoteFleetStore.getState();

    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/remote-fleet/terminal/open', {
      method: 'POST',
      body: JSON.stringify({ endpointId: 'endpoint-1', size: { rows: 30, cols: 100 } }),
    });
    expect(result.terminalConnection.ticket).toBe('terminal-ticket-secret');
    expect(state.sessions).toEqual([
      {
        id: 'terminal-session-1',
        nodeId: 'node-1',
        runtimeId: 'runtime-1',
        endpointId: 'endpoint-1',
        targetKind: 'ssh-host',
        status: 'connected',
      },
    ]);
    expect(JSON.stringify(state)).not.toContain('terminal-ticket-secret');
    expect(JSON.stringify(state)).not.toContain('session-token-secret');
    expect(JSON.stringify(state)).not.toContain('raw stdout');
    expect(state.mutatingAction).toBeNull();
  });

  it('reconnects, closes, and lists terminal sessions through terminal routes without storing tickets or logs', async () => {
    hostApiFetchMock
      .mockResolvedValueOnce({
        session: { id: 'terminal-session-1', nodeId: 'node-1', status: 'connected', logs: ['raw log'] },
        terminalConnection: {
          sessionId: 'terminal-session-1',
          ticket: 'terminal-reconnect-ticket',
          websocketPath: '/api/remote-fleet/terminal/stream?sessionId=terminal-session-1&ticket=terminal-reconnect-ticket',
          expiresAt: '2026-07-08T00:01:30.000Z',
        },
      })
      .mockResolvedValueOnce({ session: { id: 'terminal-session-1', nodeId: 'node-1', status: 'closed', stderr: 'raw stderr' } })
      .mockResolvedValueOnce({
        sessions: [
          { id: 'terminal-session-1', nodeId: 'node-1', status: 'closed', authorization: 'Bearer secret' },
        ],
      });

    const { useRemoteFleetStore } = await import('@/stores/remote-fleet');
    const reconnectResult = await useRemoteFleetStore.getState().reconnectTerminal('terminal-session-1');
    await useRemoteFleetStore.getState().closeTerminal('terminal-session-1', 'user closed');
    const sessions = await useRemoteFleetStore.getState().listTerminalSessions();
    const state = useRemoteFleetStore.getState();

    expect(hostApiFetchMock).toHaveBeenNthCalledWith(1, '/api/remote-fleet/terminal/reconnect', {
      method: 'POST',
      body: JSON.stringify({ sessionId: 'terminal-session-1' }),
    });
    expect(hostApiFetchMock).toHaveBeenNthCalledWith(2, '/api/remote-fleet/terminal/close', {
      method: 'POST',
      body: JSON.stringify({ sessionId: 'terminal-session-1', reason: 'user closed' }),
    });
    expect(hostApiFetchMock).toHaveBeenNthCalledWith(3, '/api/remote-fleet/terminal/sessions');
    expect(reconnectResult.terminalConnection.ticket).toBe('terminal-reconnect-ticket');
    expect(sessions).toEqual([{ id: 'terminal-session-1', nodeId: 'node-1', status: 'closed' }]);
    expect(state.sessions).toEqual(sessions);
    expect(JSON.stringify(state)).not.toContain('terminal-reconnect-ticket');
    expect(JSON.stringify(state)).not.toContain('raw log');
    expect(JSON.stringify(state)).not.toContain('raw stderr');
    expect(JSON.stringify(state)).not.toContain('Bearer secret');
    expect(state.mutatingAction).toBeNull();
  });

  it('listCommands and listAuditEvents call runtime-host routes and update only their slices', async () => {
    hostApiFetchMock
      .mockResolvedValueOnce({
        commands: [
          {
            id: 'command-1',
            runtimeId: 'runtime-1',
            command: 'remoteFleet.runtime.start',
            status: 'running',
            idempotencyKey: 'idem-secret',
            accessToken: 'access-token-secret',
            refreshToken: 'refresh-token-secret',
          },
        ],
      })
      .mockResolvedValueOnce({
        auditEvents: [
          {
            id: 'audit-1',
            eventName: 'remoteFleet.command.running',
            commandId: 'command-1',
            occurredAt: '2026-01-01T00:01:00.000Z',
            secret: 'audit-secret',
          },
        ],
      });

    const { useRemoteFleetStore } = await import('@/stores/remote-fleet');
    const commands = await useRemoteFleetStore.getState().listCommands();
    let state = useRemoteFleetStore.getState();

    expect(hostApiFetchMock).toHaveBeenNthCalledWith(1, '/api/remote-fleet/list-commands');
    expect(commands).toEqual([
      {
        id: 'command-1',
        runtimeId: 'runtime-1',
        command: 'remoteFleet.runtime.start',
        status: 'running',
      },
    ]);
    expect(state.commands).toEqual(commands);
    expect(state.auditEvents).toEqual([]);
    expect(state.nodes).toEqual([]);
    expect(state.agents).toEqual([]);
    expect(state.runtimes).toEqual([]);
    expect(state.endpoints).toEqual([]);
    expect(state.capabilities).toEqual([]);
    expect(state.leases).toEqual([]);
    expect(JSON.stringify(commands)).not.toContain('idem-secret');
    expect(JSON.stringify(commands)).not.toContain('access-token-secret');
    expect(JSON.stringify(commands)).not.toContain('refresh-token-secret');
    expect(state.ready).toBe(false);
    expect(state.mutatingAction).toBeNull();

    const auditEvents = await useRemoteFleetStore.getState().listAuditEvents();
    state = useRemoteFleetStore.getState();

    expect(hostApiFetchMock).toHaveBeenNthCalledWith(2, '/api/remote-fleet/list-audit-events');
    expect(auditEvents).toEqual([
      {
        id: 'audit-1',
        eventName: 'remoteFleet.command.running',
        commandId: 'command-1',
        occurredAt: '2026-01-01T00:01:00.000Z',
      },
    ]);
    expect(state.commands).toEqual(commands);
    expect(state.auditEvents).toEqual(auditEvents);
    expect(state.nodes).toEqual([]);
    expect(state.agents).toEqual([]);
    expect(state.runtimes).toEqual([]);
    expect(state.endpoints).toEqual([]);
    expect(state.capabilities).toEqual([]);
    expect(state.leases).toEqual([]);
    expect(JSON.stringify(auditEvents)).not.toContain('audit-secret');
    expect(state.ready).toBe(false);
    expect(state.mutatingAction).toBeNull();
  });
});
