import { describe, expect, it, vi } from 'vitest';
import {
  createRemoteFleetBootstrapCommandEnvelope,
  createRemoteFleetBootstrapDispatcher,
  createRemoteFleetDockerBootstrapProvider,
  type RemoteFleetBootstrapCommandEnvelope,
  type RemoteFleetBootstrapProvider,
  type RemoteFleetBootstrapSecretResolverPort,
} from '../../runtime-host/application/remote-fleet';
import type { RuntimeHttpResponse } from '../../runtime-host/application/common/runtime-ports';

function bootstrapEnvelope(overrides: Partial<RemoteFleetBootstrapCommandEnvelope> = {}): RemoteFleetBootstrapCommandEnvelope {
  return {
    envelopeVersion: 'remote-fleet-bootstrap-command/v1',
    commandId: 'bootstrap-command-1',
    idempotencyKey: 'bootstrap-idem-1',
    commandName: 'probe-node',
    providerKind: 'ssh',
    nodeId: 'node-1',
    agentId: 'agent-1',
    node: {
      id: 'node-1',
      displayName: 'Node 1',
      targetKind: 'ssh-host',
      labels: [],
      enabled: true,
      publicConfig: {},
      secretRefs: {
        sshPrivateKey: { kind: 'secret-ref', ref: 'remote-fleet://node-1/ssh-private-key' },
      },
      health: { reason: 'unknown' },
      createdAt: '2026-07-07T10:00:00.000Z',
      updatedAt: '2026-07-07T10:00:00.000Z',
    },
    agent: {
      id: 'agent-1',
      nodeId: 'node-1',
      displayName: 'Agent 1',
      enrollment: { reason: 'not-installed' },
      capabilities: [],
      createdAt: '2026-07-07T10:00:00.000Z',
      updatedAt: '2026-07-07T10:00:00.000Z',
    },
    ...overrides,
  };
}

describe('Remote Fleet bootstrap dispatcher', () => {
  it('builds deploy/delete environment bootstrap envelopes with environment and managedResource context', () => {
    const baseEnvelope = bootstrapEnvelope();
    const environment = {
      id: 'environment-1',
      connectionId: 'connection-1',
      displayName: 'Environment 1',
      environmentKind: 'ssh-workdir',
      labels: [],
      enabled: true,
      publicConfig: {},
      secretRefs: {},
      lifecycle: { reason: 'registered' },
      managedResourceIds: ['managed-resource-1'],
      createdAt: '2026-07-07T10:00:00.000Z',
      updatedAt: '2026-07-07T10:00:00.000Z',
    } as const;
    const managedResource = {
      id: 'managed-resource-1',
      connectionId: 'connection-1',
      environmentId: 'environment-1',
      providerKind: 'ssh',
      resourceKind: 'ssh-agent-installation',
      remoteResourceId: 'ssh-agent-installation-1',
      remoteRefs: [
        {
          providerKind: 'ssh',
          resourceKind: 'ssh-agent-installation',
          remoteResourceId: 'ssh-agent-installation-1',
        },
      ],
      displayName: 'SSH Agent Installation',
      labels: [],
      ownership: { reason: 'unverified', message: 'existing install' },
      cleanupPolicy: { mode: 'uninstall-agent-only' },
      lifecycle: { reason: 'observed' },
      createdAt: '2026-07-07T10:00:00.000Z',
      updatedAt: '2026-07-07T10:00:00.000Z',
    } as const;

    const deployEnvelope = createRemoteFleetBootstrapCommandEnvelope({
      commandId: 'deploy-command-1',
      idempotencyKey: 'deploy-idem-1',
      commandName: 'deploy-environment',
      node: baseEnvelope.node,
      environment,
      agent: baseEnvelope.agent,
    });
    const deleteEnvelope = createRemoteFleetBootstrapCommandEnvelope({
      commandId: 'delete-command-1',
      idempotencyKey: 'delete-idem-1',
      commandName: 'delete-environment',
      node: baseEnvelope.node,
      environment,
      managedResource,
      agent: baseEnvelope.agent,
    });

    expect(deployEnvelope).toMatchObject({
      commandName: 'deploy-environment',
      providerKind: 'ssh',
      environment,
    });
    expect(deleteEnvelope).toMatchObject({
      commandName: 'delete-environment',
      providerKind: 'ssh',
      environment,
      managedResource,
    });
  });

  it('selects the provider matching the bootstrap command envelope provider kind', async () => {
    const sshDispatch = vi.fn<RemoteFleetBootstrapProvider['dispatchCommand']>(async (envelope) => ({
      resultType: 'completed',
      commandId: envelope.commandId,
      providerKind: 'ssh',
      message: 'ssh selected',
    }));
    const dockerDispatch = vi.fn<RemoteFleetBootstrapProvider['dispatchCommand']>();
    const dispatcher = createRemoteFleetBootstrapDispatcher({
      providers: [
        { providerKind: 'docker', dispatchCommand: dockerDispatch },
        { providerKind: 'ssh', dispatchCommand: sshDispatch },
      ],
    });
    const envelope = bootstrapEnvelope();

    await expect(dispatcher.dispatchCommand(envelope)).resolves.toEqual({
      resultType: 'completed',
      commandId: 'bootstrap-command-1',
      providerKind: 'ssh',
      message: 'ssh selected',
    });
    expect(sshDispatch).toHaveBeenCalledWith(envelope, expect.objectContaining({
      httpClient: undefined,
      commandExecutor: undefined,
      timer: undefined,
    }));
    expect(dockerDispatch).not.toHaveBeenCalled();
  });

  it('returns typed unavailable when no provider is registered for the envelope provider kind', async () => {
    const dispatcher = createRemoteFleetBootstrapDispatcher({ providers: [] });

    await expect(dispatcher.dispatchCommand(bootstrapEnvelope())).resolves.toEqual({
      resultType: 'failed',
      commandId: 'bootstrap-command-1',
      providerKind: 'ssh',
      reason: 'unavailable',
      message: 'Remote Fleet bootstrap provider ssh is unavailable.',
    });
  });

  it('resolves provider secrets through the host secret resolver using Remote Fleet purpose', async () => {
    const resolveSecret = vi.fn<RemoteFleetBootstrapSecretResolverPort['resolveSecret']>(async () => ({
      resultType: 'resolved',
      secretRef: 'remote-fleet://node-1/ssh-private-key',
      plaintextSecretValue: 'plain-private-key',
    }));
    const provider: RemoteFleetBootstrapProvider = {
      providerKind: 'ssh',
      async dispatchCommand(envelope, context) {
        const readResult = await context.secrets.readSecret('sshPrivateKey');
        return readResult.resultType === 'resolved'
          ? {
              resultType: 'completed',
              commandId: envelope.commandId,
              providerKind: envelope.providerKind,
              outputSummary: 'resolved secret consumed by provider boundary',
            }
          : {
              resultType: 'failed',
              commandId: envelope.commandId,
              providerKind: envelope.providerKind,
              reason: 'missing-secret',
              message: readResult.resultType,
            };
      },
    };
    const dispatcher = createRemoteFleetBootstrapDispatcher({
      secretResolver: { resolveSecret },
      providers: [provider],
    });

    const result = await dispatcher.dispatchCommand(bootstrapEnvelope());

    expect(result).toMatchObject({
      resultType: 'completed',
      commandId: 'bootstrap-command-1',
      providerKind: 'ssh',
      outputSummary: 'resolved secret consumed by provider boundary',
    });
    expect(resolveSecret).toHaveBeenCalledWith({
      secretRef: 'remote-fleet://node-1/ssh-private-key',
      purpose: 'worker-command-execution',
      commandExecutionId: 'bootstrap-command-1',
    });
    expect(JSON.stringify(result)).not.toContain('plain-private-key');
  });

  it('resolves bootstrap secrets from connection before node and falls back to environment refs', async () => {
    const resolveSecret = vi.fn<RemoteFleetBootstrapSecretResolverPort['resolveSecret']>(async (input) => ({
      resultType: 'resolved',
      secretRef: input.secretRef,
      plaintextSecretValue: `plain:${input.secretRef}`,
    }));
    const readResults: unknown[] = [];
    const provider: RemoteFleetBootstrapProvider = {
      providerKind: 'ssh',
      async dispatchCommand(envelope, context) {
        readResults.push(await context.secrets.readSecret('sharedSecret'));
        readResults.push(await context.secrets.readSecret('environmentOnlySecret'));
        return {
          resultType: 'completed',
          commandId: envelope.commandId,
          providerKind: envelope.providerKind,
        };
      },
    };
    const baseEnvelope = bootstrapEnvelope();
    const dispatcher = createRemoteFleetBootstrapDispatcher({
      secretResolver: { resolveSecret },
      providers: [provider],
    });

    await dispatcher.dispatchCommand(bootstrapEnvelope({
      connection: {
        id: 'connection-1',
        displayName: 'Connection 1',
        connectionKind: 'ssh-host',
        labels: [],
        enabled: true,
        publicConfig: {},
        secretRefs: {
          sharedSecret: { kind: 'secret-ref', ref: 'remote-fleet://connection-1/shared-secret' },
        },
        health: { reason: 'unknown' },
        createdAt: '2026-07-07T10:00:00.000Z',
        updatedAt: '2026-07-07T10:00:00.000Z',
      },
      node: {
        ...baseEnvelope.node,
        secretRefs: {
          sharedSecret: { kind: 'secret-ref', ref: 'remote-fleet://node-1/shared-secret' },
        },
      },
      environment: {
        id: 'environment-1',
        connectionId: 'connection-1',
        displayName: 'Environment 1',
        environmentKind: 'ssh-workdir',
        labels: [],
        enabled: true,
        publicConfig: {},
        secretRefs: {
          sharedSecret: { kind: 'secret-ref', ref: 'remote-fleet://environment-1/shared-secret' },
          environmentOnlySecret: { kind: 'secret-ref', ref: 'remote-fleet://environment-1/environment-only-secret' },
        },
        lifecycle: { reason: 'registered' },
        managedResourceIds: [],
        createdAt: '2026-07-07T10:00:00.000Z',
        updatedAt: '2026-07-07T10:00:00.000Z',
      },
    }));

    expect(readResults).toEqual([
      {
        resultType: 'resolved',
        secretRefName: 'sharedSecret',
        secretRef: { kind: 'secret-ref', ref: 'remote-fleet://connection-1/shared-secret' },
        plaintextSecretValue: 'plain:remote-fleet://connection-1/shared-secret',
      },
      {
        resultType: 'resolved',
        secretRefName: 'environmentOnlySecret',
        secretRef: { kind: 'secret-ref', ref: 'remote-fleet://environment-1/environment-only-secret' },
        plaintextSecretValue: 'plain:remote-fleet://environment-1/environment-only-secret',
      },
    ]);
    expect(resolveSecret).toHaveBeenNthCalledWith(1, {
      secretRef: 'remote-fleet://connection-1/shared-secret',
      purpose: 'worker-command-execution',
      commandExecutionId: 'bootstrap-command-1',
    });
    expect(resolveSecret).toHaveBeenNthCalledWith(2, {
      secretRef: 'remote-fleet://environment-1/environment-only-secret',
      purpose: 'worker-command-execution',
      commandExecutionId: 'bootstrap-command-1',
    });
  });

  it('resolves the environment-selected Docker deploy ref rather than generic connection or node refs', async () => {
    const connectionRef = 'remote-fleet://connection-1/docker-bearer-token';
    const nodeRef = 'remote-fleet://node-1/docker-bearer-token';
    const environmentRef = 'remote-fleet://environment-1/docker-bearer-token';
    const environmentToken = 'environment-selected-docker-bearer-token';
    const resolveSecret = vi.fn<RemoteFleetBootstrapSecretResolverPort['resolveSecret']>(async (input) => ({
      resultType: 'resolved',
      secretRef: input.secretRef,
      plaintextSecretValue: input.secretRef === environmentRef
        ? environmentToken
        : `unexpected-token:${input.secretRef}`,
    }));
    const requests: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    const httpClient = {
      request: vi.fn(async (url: string, init?: RequestInit): Promise<RuntimeHttpResponse> => {
        requests.push({ url, init });
        const pathname = new URL(url).pathname;
        if (pathname.endsWith('/images/registry.example.test%2Fenvironment-runtime%3A1/json')) {
          return { ok: true, status: 200, json: async () => ({ Id: 'environment-image' }), text: async () => '' };
        }
        if (pathname.endsWith('/containers/create')) {
          return { ok: true, status: 201, json: async () => ({ Id: 'environment-container' }), text: async () => '' };
        }
        if (pathname.endsWith('/containers/environment-container/start')) {
          return { ok: true, status: 204, json: async () => ({}), text: async () => '' };
        }
        throw new Error(`Unexpected Docker request ${url}`);
      }),
    };
    const baseEnvelope = bootstrapEnvelope();
    const connection = {
      id: 'connection-1',
      displayName: 'Connection 1',
      connectionKind: 'container',
      labels: [],
      enabled: true,
      publicConfig: { docker: { endpointUrl: 'https://docker.example.test:2376' } },
      secretRefs: { dockerBearerToken: { kind: 'secret-ref', ref: connectionRef } },
      health: { reason: 'unknown' },
      createdAt: '2026-07-07T10:00:00.000Z',
      updatedAt: '2026-07-07T10:00:00.000Z',
    } as const;
    const node = {
      ...baseEnvelope.node,
      targetKind: 'container' as const,
      publicConfig: { docker: {} },
      secretRefs: { dockerBearerToken: { kind: 'secret-ref' as const, ref: nodeRef } },
    };
    const environment = {
      id: 'environment-1',
      connectionId: connection.id,
      displayName: 'Environment 1',
      environmentKind: 'docker-container',
      labels: [],
      enabled: true,
      publicConfig: {
        docker: {
          image: 'registry.example.test/environment-runtime:1',
          containerName: 'environment-runtime-container',
        },
      },
      secretRefs: { dockerBearerToken: { kind: 'secret-ref', ref: environmentRef } },
      lifecycle: { reason: 'registered' },
      managedResourceIds: [],
      createdAt: '2026-07-07T10:00:00.000Z',
      updatedAt: '2026-07-07T10:00:00.000Z',
    } as const;
    const dispatcher = createRemoteFleetBootstrapDispatcher({
      httpClient,
      secretResolver: { resolveSecret },
      providers: [createRemoteFleetDockerBootstrapProvider()],
    });

    const result = await dispatcher.dispatchCommand(bootstrapEnvelope({
      commandName: 'deploy-environment',
      providerKind: 'docker',
      connection,
      node,
      environment,
    }));

    expect(result).toMatchObject({
      resultType: 'completed',
      commandId: 'bootstrap-command-1',
      providerKind: 'docker',
      remoteResourceId: 'environment-container',
    });
    expect(resolveSecret).toHaveBeenCalledTimes(1);
    expect(resolveSecret).toHaveBeenCalledWith({
      secretRef: environmentRef,
      purpose: 'worker-command-execution',
      commandExecutionId: 'bootstrap-command-1',
    });
    expect(requests).toHaveLength(3);
    expect(requests.every((request) => request.init?.headers && (request.init.headers as Record<string, string>).authorization === `Bearer ${environmentToken}`)).toBe(true);
    const serialized = JSON.stringify({
      result,
      requestUrls: requests.map((request) => request.url),
      requestBodies: requests.map((request) => request.init?.body),
    });
    expect(serialized).not.toContain(environmentToken);
    expect(serialized).not.toContain(connectionRef);
    expect(serialized).not.toContain(nodeRef);
  });

  it('does not call the resolver for missing or policy-denied secret refs', async () => {
    const resolveSecret = vi.fn<RemoteFleetBootstrapSecretResolverPort['resolveSecret']>();
    const readResults: unknown[] = [];
    const provider: RemoteFleetBootstrapProvider = {
      providerKind: 'ssh',
      async dispatchCommand(envelope, context) {
        readResults.push(await context.secrets.readSecret('missingSecret'));
        readResults.push(await context.secrets.readSecret('sshPrivateKey'));
        return {
          resultType: 'failed',
          commandId: envelope.commandId,
          providerKind: envelope.providerKind,
          reason: 'missing-secret',
          message: 'secret checks completed',
        };
      },
    };
    const dispatcher = createRemoteFleetBootstrapDispatcher({
      secretResolver: { resolveSecret },
      providers: [provider],
    });

    await dispatcher.dispatchCommand(bootstrapEnvelope({
      node: {
        ...bootstrapEnvelope().node,
        secretRefs: {
          sshPrivateKey: { kind: 'secret-ref', ref: 'provider://node-1/ssh-private-key' },
        },
      },
    }));

    expect(readResults).toEqual([
      { resultType: 'missing', secretRefName: 'missingSecret' },
      {
        resultType: 'accessDenied',
        secretRefName: 'sshPrivateKey',
        secretRef: { kind: 'secret-ref', ref: 'provider://node-1/ssh-private-key' },
      },
    ]);
    expect(resolveSecret).not.toHaveBeenCalled();
  });

  it('returns unavailable secret reads without throwing when no secret resolver is wired', async () => {
    const provider: RemoteFleetBootstrapProvider = {
      providerKind: 'ssh',
      async dispatchCommand(envelope, context) {
        const readResult = await context.secrets.readSecret('sshPrivateKey');
        return {
          resultType: 'failed',
          commandId: envelope.commandId,
          providerKind: envelope.providerKind,
          reason: 'unavailable',
          message: readResult.resultType,
        };
      },
    };
    const dispatcher = createRemoteFleetBootstrapDispatcher({ providers: [provider] });

    await expect(dispatcher.dispatchCommand(bootstrapEnvelope())).resolves.toEqual({
      resultType: 'failed',
      commandId: 'bootstrap-command-1',
      providerKind: 'ssh',
      reason: 'unavailable',
      message: 'unavailable',
    });
  });
});
