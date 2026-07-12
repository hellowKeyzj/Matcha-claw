import { describe, expect, it } from 'vitest';
import {
  REMOTE_FLEET_CONNECTOR_COMMAND_KINDS,
  REMOTE_FLEET_CONNECTOR_PROVIDER_REGISTRY,
  dispatchRemoteFleetConnectorCommand,
  getRemoteFleetConnectorProviderContract,
  validateRemoteFleetConnectorCommand,
  type RemoteFleetConnectorCommand,
  type RuntimeAgentCommandRequest,
} from '../../runtime-host/application/remote-fleet/remote-fleet-connectors';
import type {
  RemoteFleetNodeRecord,
  RemoteFleetNodeTargetKind,
  RemoteFleetSecretRef,
  RuntimeInstanceRecord,
} from '../../runtime-host/application/remote-fleet/remote-fleet-model';

const now = '2026-07-07T00:00:00.000Z';
const sshPrivateKeyRef: RemoteFleetSecretRef = { kind: 'secret-ref', ref: 'vault://remote-fleet/node/ssh-key' };

type TargetCase = {
  readonly targetKind: RemoteFleetNodeTargetKind;
  readonly providerKind: string;
};

const targetCases: readonly TargetCase[] = [
  { targetKind: 'ssh-host', providerKind: 'ssh' },
  { targetKind: 'container', providerKind: 'docker' },
  { targetKind: 'vm', providerKind: 'vm' },
  { targetKind: 'k8s-pod', providerKind: 'k8s' },
  { targetKind: 'custom', providerKind: 'custom' },
];

function nodeRecord(overrides: Partial<RemoteFleetNodeRecord> = {}): RemoteFleetNodeRecord {
  return {
    id: 'node-1',
    displayName: 'Node 1',
    targetKind: 'ssh-host',
    labels: [],
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
    runtimeKind: 'openclaw',
    lifecycle: { reason: 'stopped' },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function connectorCommand(overrides: Partial<RemoteFleetConnectorCommand> = {}): RemoteFleetConnectorCommand {
  return {
    id: 'cmd-1',
    kind: 'probe-node',
    nodeId: 'node-1',
    idempotencyKey: 'remote-fleet:cmd-1',
    ...overrides,
  };
}

describe('Remote Fleet connector provider registry', () => {
  it('declares one post-enrollment RuntimeAgent command-channel provider contract for every node target kind', () => {
    for (const { targetKind, providerKind } of targetCases) {
      const contract = getRemoteFleetConnectorProviderContract(targetKind);

      expect(contract).toMatchObject({
        providerKind,
        targetKind,
        executionMode: 'runtime-agent-command-channel',
      });
      expect(contract?.commandContracts.map((command) => command.commandKind).sort()).toEqual(
        [...REMOTE_FLEET_CONNECTOR_COMMAND_KINDS].sort(),
      );
    }
  });

  it('exposes providers through the registry by target kind', () => {
    for (const { targetKind, providerKind } of targetCases) {
      expect(REMOTE_FLEET_CONNECTOR_PROVIDER_REGISTRY.getProviderForTargetKind(targetKind)).toMatchObject({
        kind: providerKind,
      });
    }
  });

  it('rejects plaintext secret-shaped publicConfig through the command policy gate', () => {
    const decision = validateRemoteFleetConnectorCommand({
      node: nodeRecord({ targetKind: 'ssh-host' }),
      runtime: runtimeRecord(),
      publicConfig: { runtimeLaunch: { env: { API_TOKEN: 'plaintext-token' } } },
      secretRefs: {},
      command: connectorCommand({ kind: 'start-runtime', runtimeId: 'runtime-1' }),
      commandChannel: { send: async () => ({ resultType: 'accepted', commandId: 'cmd-1' }) },
    });

    expect(decision).toMatchObject({
      resultType: 'rejected',
      commandId: 'cmd-1',
      reason: 'invalid-config',
      message: 'Remote Fleet publicConfig must not contain plaintext credential key publicConfig.runtimeLaunch.env.API_TOKEN.',
    });
  });

  it('returns typed unavailable when no RuntimeAgent command channel exists for an otherwise supported command', () => {
    const decision = validateRemoteFleetConnectorCommand({
      node: nodeRecord({ targetKind: 'container' }),
      runtime: runtimeRecord(),
      publicConfig: {},
      secretRefs: {},
      command: connectorCommand({ kind: 'start-runtime', runtimeId: 'runtime-1' }),
    });

    expect(decision).toEqual({
      resultType: 'unavailable',
      commandId: 'cmd-1',
      reason: 'runtime-agent-command-channel-required',
      message: 'Remote Fleet connector provider remote-fleet.connector.docker requires a RuntimeAgent command channel for command execution.',
      targetKind: 'container',
      providerKind: 'docker',
    });
  });

  it.each([
    ['ssh-host', 'ssh', 'bootstrap-provider-owned'],
    ['container', 'docker', 'bootstrap-provider-owned'],
    ['k8s-pod', 'k8s', 'bootstrap-provider-owned'],
    ['vm', 'vm', 'bootstrap-provider-owned'],
    ['custom', 'custom', 'bootstrap-provider-unavailable'],
  ] as const)('keeps %s install-agent outside the post-enrollment connector dispatch path', (targetKind, providerKind, reason) => {
    const decision = validateRemoteFleetConnectorCommand({
      node: nodeRecord({ targetKind }),
      publicConfig: {},
      secretRefs: {},
      command: connectorCommand({ kind: 'install-agent' }),
      commandChannel: { send: async () => ({ resultType: 'accepted', commandId: 'cmd-1' }) },
    });

    expect(decision).toMatchObject({
      resultType: 'unsupported',
      commandId: 'cmd-1',
      reason,
      targetKind,
      providerKind,
      commandKind: 'install-agent',
    });
  });

  it('keeps capability sync owned by RuntimeAgent ingress instead of issuing a host-side command', () => {
    const decision = validateRemoteFleetConnectorCommand({
      node: nodeRecord({ targetKind: 'ssh-host' }),
      publicConfig: {},
      secretRefs: {},
      command: connectorCommand({ kind: 'sync-capabilities' }),
      commandChannel: { send: async () => ({ resultType: 'accepted', commandId: 'cmd-1' }) },
    });

    expect(decision).toEqual({
      resultType: 'unsupported',
      commandId: 'cmd-1',
      reason: 'capability-sync-owned-by-runtime-agent',
      message: 'Remote Fleet capability sync is ingressed by RuntimeAgent via runtime-agent.capabilities.sync; this connector slice does not issue host-side sync-capabilities commands.',
      targetKind: 'ssh-host',
      providerKind: 'ssh',
      commandKind: 'sync-capabilities',
    });
  });

  it('maps command-policy unsupported runtime kinds to typed unsupported results', () => {
    const decision = validateRemoteFleetConnectorCommand({
      node: nodeRecord({ targetKind: 'ssh-host' }),
      runtime: runtimeRecord({ runtimeKind: 'plugin-runtime' }),
      publicConfig: {},
      secretRefs: {},
      command: connectorCommand({ kind: 'start-runtime', runtimeId: 'runtime-1' }),
      commandChannel: { send: async () => ({ resultType: 'accepted', commandId: 'cmd-1' }) },
    });

    expect(decision).toMatchObject({
      resultType: 'unsupported',
      commandId: 'cmd-1',
      reason: 'command-policy-unsupported',
      runtimeKind: 'plugin-runtime',
      commandKind: 'start-runtime',
    });
  });

  it('dispatches only through RuntimeAgent command channel and never resolves plaintext secrets in-process', async () => {
    const sentRequests: RuntimeAgentCommandRequest[] = [];
    const result = await dispatchRemoteFleetConnectorCommand({
      node: nodeRecord({
        targetKind: 'ssh-host',
        publicConfig: { ignoredByConnectorInput: true },
        secretRefs: { sshPrivateKey: sshPrivateKeyRef },
      }),
      runtime: runtimeRecord(),
      publicConfig: {},
      secretRefs: { sshPrivateKey: sshPrivateKeyRef },
      secrets: {
        readSecret: async () => {
          throw new Error('connector dispatch must not resolve secrets in-process');
        },
      },
      commandChannel: {
        send: async (request) => {
          sentRequests.push(request);
          return { resultType: 'accepted', commandId: request.commandId, remoteCommandId: 'remote-cmd-1' };
        },
      },
    }, connectorCommand({ kind: 'start-runtime', runtimeId: 'runtime-1' }));

    expect(result).toEqual({
      resultType: 'accepted',
      commandId: 'cmd-1',
      remoteCommandId: 'remote-cmd-1',
    });
    expect(sentRequests).toHaveLength(1);
    expect(sentRequests[0]).toMatchObject({
      commandId: 'cmd-1',
      kind: 'start-runtime',
      publicConfig: {},
      node: {
        id: 'node-1',
        targetKind: 'ssh-host',
        publicConfig: {},
        secretRefs: { sshPrivateKey: sshPrivateKeyRef },
      },
    });
    expect(JSON.stringify(sentRequests[0])).not.toContain('redacted-secret-value');
    expect(JSON.stringify(sentRequests[0])).not.toContain('plaintext-token');
  });
});
