import { describe, expect, it } from 'vitest';
import {
  buildRemoteFleetCommandDispatchEnvelope,
} from '../../runtime-host/application/remote-fleet/remote-fleet-command-dispatch';
import type {
  RemoteFleetCommandRecord,
  RemoteFleetNodeRecord,
  RemoteRuntimeEndpointRecord,
  RuntimeInstanceRecord,
} from '../../runtime-host/application/remote-fleet/remote-fleet-model';

const now = '2026-07-06T10:00:00.000Z';

function nodeRecord(overrides: Partial<RemoteFleetNodeRecord> = {}): RemoteFleetNodeRecord {
  return {
    id: 'node-1',
    displayName: 'Node 1',
    targetKind: 'container',
    endpointUrl: 'https://node-1.internal',
    labels: ['remote'],
    enabled: true,
    publicConfig: {},
    secretRefs: {},
    health: { reason: 'online', lastSeenAt: now },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function runtimeRecord(overrides: Partial<RuntimeInstanceRecord> = {}): RuntimeInstanceRecord {
  return {
    id: 'runtime-1',
    nodeId: 'node-1',
    agentId: 'agent-1',
    displayName: 'Runtime 1',
    runtimeKind: 'matcha-agent',
    endpointId: 'endpoint-1',
    lifecycle: { reason: 'stopped' },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function endpointRecord(overrides: Partial<RemoteRuntimeEndpointRecord> = {}): RemoteRuntimeEndpointRecord {
  return {
    id: 'endpoint-1',
    nodeId: 'node-1',
    runtimeId: 'runtime-1',
    endpointRef: {
      kind: 'native-runtime',
      runtimeAdapterId: 'remote-fleet',
      runtimeInstanceId: 'runtime-1',
    },
    scope: {
      kind: 'runtime-instance',
      endpoint: {
        kind: 'native-runtime',
        runtimeAdapterId: 'remote-fleet',
        runtimeInstanceId: 'runtime-1',
      },
    },
    protocol: 'remote-fleet',
    labels: [],
    health: { reason: 'unknown' },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function commandRecord(overrides: Partial<RemoteFleetCommandRecord> = {}): RemoteFleetCommandRecord {
  return {
    id: 'cmd-1',
    idempotencyKey: 'idem:cmd-1',
    nodeId: 'node-1',
    agentId: 'agent-1',
    command: 'start-runtime',
    state: { reason: 'queued', queuedAt: now },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('Remote Fleet command dispatch envelope', () => {
  it('builds a probe-node envelope with RuntimeAgent dispatch identity and DTO-only request payload', () => {
    const node = nodeRecord({
      targetKind: 'ssh-host',
      publicConfig: {
        socketPath: '/tmp/runtime-agent.sock',
        connectorClass: 'SshRuntimeAgentConnector',
        runtimeAgent: {
          endpointUrl: 'https://runtime-agent.node-1.internal/rpc',
          credentialRefName: 'runtimeAgentToken',
          timeoutMs: 5000,
        },
      },
      secretRefs: {
        sshPrivateKey: { kind: 'secret-ref', ref: 'vault://ssh-key' },
        runtimeAgentToken: { kind: 'secret-ref', ref: 'remote-fleet://node-1/runtime-agent-token' },
      },
    });
    const command = commandRecord({ command: 'probe-node', runtimeId: undefined, endpointId: undefined });

    const result = buildRemoteFleetCommandDispatchEnvelope({ command, node });

    expect(result.resultType).toBe('built');
    if (result.resultType !== 'built') return;
    expect(result.envelope).toMatchObject({
      envelopeVersion: 'remote-fleet-command-dispatch/v1',
      commandId: 'cmd-1',
      idempotencyKey: 'idem:cmd-1',
      agentId: 'agent-1',
      nodeId: 'node-1',
      commandName: 'probe-node',
      dispatchTarget: {
        endpointUrl: 'https://runtime-agent.node-1.internal/rpc',
        credentialRef: { kind: 'secret-ref', ref: 'remote-fleet://node-1/runtime-agent-token' },
        timeoutMs: 5000,
      },
      request: {
        commandId: 'cmd-1',
        kind: 'probe-node',
        publicConfig: {
          dispatchContract: {
            envelopeVersion: 'remote-fleet-command-dispatch/v1',
            commandName: 'probe-node',
          },
        },
        payload: {
          payloadType: 'runtime-agent-probe-node',
          nodeId: 'node-1',
          agentId: 'agent-1',
          target: {
            targetKind: 'ssh-host',
            endpointUrl: 'https://node-1.internal',
            labels: ['remote'],
          },
        },
      },
    });
    expect(result.envelope).not.toHaveProperty('runtimeId');
    expect(result.envelope).not.toHaveProperty('endpointId');
    expect(result.envelope.request.node.publicConfig).toEqual({});
    expect(result.envelope.request.node.secretRefs).toEqual({});
    expect(JSON.stringify(result.envelope.request)).not.toContain('vault://ssh-key');
    expect(JSON.stringify(result.envelope.request)).not.toContain('/tmp/runtime-agent.sock');
    expect(JSON.stringify(result.envelope.request)).not.toContain('SshRuntimeAgentConnector');
  });

  it('omits unsafe endpointUrl credential material from RuntimeAgent target payloads', () => {
    const node = nodeRecord({
      targetKind: 'ssh-host',
      endpointUrl: 'https://node.example.test/callback?api_key=runtime-secret',
    });
    const command = commandRecord({ command: 'probe-node', runtimeId: undefined, endpointId: undefined });

    const result = buildRemoteFleetCommandDispatchEnvelope({ command, node });

    expect(result.resultType).toBe('built');
    if (result.resultType !== 'built') return;
    expect(result.envelope.request.payload).toMatchObject({
      payloadType: 'runtime-agent-probe-node',
      target: { targetKind: 'ssh-host', labels: ['remote'] },
    });
    expect(JSON.stringify(result.envelope)).not.toContain('api_key');
    expect(JSON.stringify(result.envelope)).not.toContain('runtime-secret');
  });

  it('builds a start-runtime envelope with launch spec secret placeholders and no plaintext secret value', () => {
    const node = nodeRecord({
      publicConfig: {
        runtimeLaunch: {
          matchaAgent: { launchMode: 'app-server', appServerBasePath: '/matcha-agent' },
          env: { MATCHA_RUNTIME_MODE: 'remote' },
          secretEnv: { ANTHROPIC_API_KEY: 'anthropicApiKey' },
        },
      },
      secretRefs: { anthropicApiKey: { kind: 'secret-ref', ref: 'remote-fleet://node-1/anthropic' } },
    });
    const runtime = runtimeRecord();
    const endpoint = endpointRecord();
    const command = commandRecord({ runtimeId: runtime.id, endpointId: endpoint.id });

    const result = buildRemoteFleetCommandDispatchEnvelope({ command, node, runtime, endpoint });

    expect(result.resultType).toBe('built');
    if (result.resultType !== 'built') return;
    expect(result.envelope).toMatchObject({
      envelopeVersion: 'remote-fleet-command-dispatch/v1',
      commandId: 'cmd-1',
      idempotencyKey: 'idem:cmd-1',
      agentId: 'agent-1',
      nodeId: 'node-1',
      runtimeId: 'runtime-1',
      endpointId: 'endpoint-1',
      commandName: 'start-runtime',
      request: {
        commandId: 'cmd-1',
        kind: 'start-runtime',
        runtime: expect.objectContaining({ id: 'runtime-1', runtimeKind: 'matcha-agent' }),
        payload: expect.objectContaining({
          payloadType: 'remote-runtime-launch',
          launchCommand: expect.objectContaining({
            commandVersion: 'remote-runtime-launch-command/v1',
            commandType: 'start-runtime',
            runtimeKind: 'matcha-agent',
            executable: { kind: 'matcha-agent-runtime', launchMode: 'app-server', appServerBasePath: '/matcha-agent' },
          }),
          capabilitySync: expect.objectContaining({ strategy: 'runtime-agent-capabilities-sync' }),
          unsupportedReasons: [],
        }),
      },
    });
    expect(result.envelope.request.publicConfig).toEqual({
      runtimeLaunch: expect.objectContaining({
        specVersion: 'remote-runtime-launch/v1',
        runtimeKind: 'matcha-agent',
        provider: { kind: 'matcha-agent', launchMode: 'app-server', appServerBasePath: '/matcha-agent' },
        environment: {
          public: [{ name: 'MATCHA_RUNTIME_MODE', value: 'remote' }],
          secrets: [{ name: 'ANTHROPIC_API_KEY', secretRefName: 'anthropicApiKey', placeholder: '{{remote-fleet.secret-env.ANTHROPIC_API_KEY}}' }],
        },
      }),
    });
    expect(result.envelope.request.payload).toMatchObject({
      launchSpec: expect.objectContaining({
        environment: expect.objectContaining({
          secrets: [{ name: 'ANTHROPIC_API_KEY', secretRefName: 'anthropicApiKey', secretRef: { kind: 'secret-ref', ref: 'remote-fleet://node-1/anthropic' }, placeholder: '{{remote-fleet.secret-env.ANTHROPIC_API_KEY}}' }],
        }),
      }),
      secretPlaceholders: [{ envName: 'ANTHROPIC_API_KEY', secretRefName: 'anthropicApiKey', secretRef: { kind: 'secret-ref', ref: 'remote-fleet://node-1/anthropic' }, placeholder: '{{remote-fleet.secret-env.ANTHROPIC_API_KEY}}' }],
    });
    expect(JSON.stringify(result.envelope)).not.toContain('sk-live-secret-plaintext');
  });

  it('returns discriminated invalid results for missing node or runtime projections', () => {
    const runtime = runtimeRecord();
    const endpoint = endpointRecord();
    const missingNode = buildRemoteFleetCommandDispatchEnvelope({
      command: commandRecord({ runtimeId: runtime.id, endpointId: endpoint.id }),
      runtime,
      endpoint,
    });
    const missingRuntime = buildRemoteFleetCommandDispatchEnvelope({
      command: commandRecord({ runtimeId: runtime.id, endpointId: endpoint.id }),
      node: nodeRecord(),
      endpoint,
    });

    expect(missingNode).toMatchObject({
      resultType: 'invalid',
      commandId: 'cmd-1',
      commandName: 'start-runtime',
      issues: [expect.objectContaining({ reason: 'missing-node', path: 'node' })],
    });
    expect(missingRuntime).toMatchObject({
      resultType: 'invalid',
      commandId: 'cmd-1',
      commandName: 'start-runtime',
      issues: [expect.objectContaining({ reason: 'missing-runtime', path: 'runtime' })],
    });
  });

  it('builds a stop-runtime envelope with an explicit runtime stop payload', () => {
    const node = nodeRecord({ publicConfig: { runtimeLaunch: { secretEnv: { API_KEY: 'apiKey' } } } });
    const runtime = runtimeRecord({ runtimeKind: 'openclaw' });
    const endpoint = endpointRecord();
    const command = commandRecord({ command: 'stop-runtime', runtimeId: runtime.id, endpointId: endpoint.id });

    const result = buildRemoteFleetCommandDispatchEnvelope({ command, node, runtime, endpoint });

    expect(result.resultType).toBe('built');
    if (result.resultType !== 'built') return;
    expect(result.envelope).toMatchObject({
      commandId: 'cmd-1',
      idempotencyKey: 'idem:cmd-1',
      agentId: 'agent-1',
      nodeId: 'node-1',
      runtimeId: 'runtime-1',
      endpointId: 'endpoint-1',
      commandName: 'stop-runtime',
      request: {
        commandId: 'cmd-1',
        kind: 'stop-runtime',
        publicConfig: {
          dispatchContract: {
            envelopeVersion: 'remote-fleet-command-dispatch/v1',
            commandName: 'stop-runtime',
          },
        },
        payload: {
          payloadType: 'remote-runtime-stop',
          runtimeId: 'runtime-1',
          runtimeKind: 'openclaw',
          endpointId: 'endpoint-1',
          endpointRef: endpoint.endpointRef,
          scope: endpoint.scope,
        },
      },
    });
    expect(result.envelope.request.node.publicConfig).toEqual({});
    expect(result.envelope.request.node.secretRefs).toEqual({});
  });

  it('builds an install-agent envelope with a semantic install payload', () => {
    const node = nodeRecord({
      targetKind: 'ssh-host',
      secretRefs: {
        sshPrivateKey: { kind: 'secret-ref', ref: 'vault://ssh-key' },
        agentPackageToken: { kind: 'secret-ref', ref: 'vault://agent-package-token' },
      },
    });
    const command = commandRecord({ command: 'install-agent', runtimeId: undefined, endpointId: undefined });

    const result = buildRemoteFleetCommandDispatchEnvelope({ command, node });

    expect(result.resultType).toBe('built');
    if (result.resultType !== 'built') return;
    expect(result.envelope).toMatchObject({
      commandId: 'cmd-1',
      idempotencyKey: 'idem:cmd-1',
      agentId: 'agent-1',
      nodeId: 'node-1',
      commandName: 'install-agent',
      request: {
        commandId: 'cmd-1',
        kind: 'install-agent',
        publicConfig: {
          dispatchContract: {
            envelopeVersion: 'remote-fleet-command-dispatch/v1',
            commandName: 'install-agent',
          },
        },
        payload: {
          payloadType: 'runtime-agent-install',
          nodeId: 'node-1',
          agentId: 'agent-1',
          target: {
            targetKind: 'ssh-host',
            endpointUrl: 'https://node-1.internal',
            labels: ['remote'],
          },
          secretRefNames: ['agentPackageToken', 'sshPrivateKey'],
        },
      },
    });
    expect(result.envelope.request.node.publicConfig).toEqual({});
    expect(result.envelope.request.node.secretRefs).toEqual({});
    expect(result.envelope).not.toHaveProperty('runtimeId');
    expect(result.envelope).not.toHaveProperty('endpointId');
  });
});
