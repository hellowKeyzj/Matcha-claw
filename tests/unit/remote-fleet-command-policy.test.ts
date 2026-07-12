import { describe, expect, it } from 'vitest';
import type { RemoteFleetConnectorCommand } from '../../runtime-host/application/remote-fleet/remote-fleet-connectors';
import type { RemoteFleetNodeRecord, RuntimeInstanceRecord } from '../../runtime-host/application/remote-fleet/remote-fleet-model';
import {
  evaluateRemoteFleetCommandPolicy,
  findUnsafeRemoteFleetEndpointUrlKey,
} from '../../runtime-host/application/remote-fleet/remote-fleet-command-policy';

const now = '2026-07-06T10:00:00.000Z';
const sshPrivateKeyRef = { kind: 'secret-ref', ref: 'vault://remote-fleet/node/ssh-key' } as const;

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
    agentId: 'node-1:agent',
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
    kind: 'install-agent',
    nodeId: 'node-1',
    idempotencyKey: 'idem:install-agent:node-1',
    ...overrides,
  };
}

describe('Remote Fleet command policy gate', () => {
  it('allows an install-agent connector command when the ssh node has the required secret ref', () => {
    const decision = evaluateRemoteFleetCommandPolicy({
      node: nodeRecord({ secretRefs: { sshPrivateKey: sshPrivateKeyRef } }),
      command: connectorCommand(),
    });

    expect(decision).toEqual({
      resultType: 'allowed',
      reason: 'command-policy-accepted',
      commandKind: 'install-agent',
      nodeId: 'node-1',
      requiredSecretRefNames: ['sshPrivateKey'],
    });
  });

  it('denies commands for disabled nodes before command-specific checks', () => {
    const decision = evaluateRemoteFleetCommandPolicy({
      node: nodeRecord({ enabled: false, publicConfig: { apiToken: 'plaintext-token' } }),
      command: connectorCommand(),
    });

    expect(decision).toMatchObject({
      resultType: 'denied',
      reason: 'node-disabled',
      commandKind: 'install-agent',
      nodeId: 'node-1',
    });
  });

  it('denies start-runtime for unsupported runtime kinds by default', () => {
    const runtime = runtimeRecord({ runtimeKind: 'plugin-runtime' });

    const decision = evaluateRemoteFleetCommandPolicy({
      node: nodeRecord(),
      runtime,
      command: connectorCommand({ kind: 'start-runtime', runtimeId: runtime.id }),
    });

    expect(decision).toMatchObject({
      resultType: 'denied',
      reason: 'unsupported-runtime-kind',
      commandKind: 'start-runtime',
      nodeId: 'node-1',
      runtimeId: 'runtime-1',
      runtimeKind: 'plugin-runtime',
    });
  });

  it('denies commands that reference missing required secret refs', () => {
    const decision = evaluateRemoteFleetCommandPolicy({
      node: nodeRecord({ secretRefs: {} }),
      command: {
        command: 'upgrade-agent',
        nodeId: 'node-1',
        requiredSecretRefNames: ['agentPackageToken'],
      },
    });

    expect(decision).toMatchObject({
      resultType: 'denied',
      reason: 'missing-secret-ref',
      commandKind: 'upgrade-agent',
      secretRefName: 'agentPackageToken',
    });
  });

  it('denies plaintext credential-shaped keys in publicConfig', () => {
    const decision = evaluateRemoteFleetCommandPolicy({
      node: nodeRecord({
        secretRefs: { sshPrivateKey: sshPrivateKeyRef },
        publicConfig: { runtimeLaunch: { env: { API_TOKEN: 'plaintext-token' } } },
      }),
      command: connectorCommand(),
    });

    expect(decision).toMatchObject({
      resultType: 'denied',
      reason: 'unsafe-public-config-key',
      path: 'publicConfig.runtimeLaunch.env.API_TOKEN',
    });
  });

  it.each([
    {
      publicConfig: { runtimeLaunch: { env: { AUTH_HEADER: 'Authorization: Bearer runtime-secret' } } },
      path: 'publicConfig.runtimeLaunch.env.AUTH_HEADER',
    },
    {
      publicConfig: { provider: { modelHint: 'sk-abcdefghi' } },
      path: 'publicConfig.provider.modelHint',
    },
    {
      publicConfig: { enrollmentHint: 'mrf_0123456789abcdef' },
      path: 'publicConfig.enrollmentHint',
    },
    {
      publicConfig: { startupArgs: '--password hunter2' },
      path: 'publicConfig.startupArgs',
    },
    {
      publicConfig: { runtimeLaunch: { envLine: 'token=plaintext-token' } },
      path: 'publicConfig.runtimeLaunch.envLine',
    },
    {
      publicConfig: { oidcHint: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJub2RlIn0.signature01' },
      path: 'publicConfig.oidcHint',
    },
    {
      publicConfig: { callbackUrl: 'https://node.example.test/callback?api_key=plaintext&mode=public' },
      path: 'publicConfig.callbackUrl',
    },
    {
      publicConfig: { runtimeLaunch: { secretEnv: { ANTHROPIC_API_KEY: 'sk-secretvalu' } } },
      path: 'publicConfig.runtimeLaunch.secretEnv.ANTHROPIC_API_KEY',
    },
  ])('denies plaintext credential-shaped values in publicConfig at $path', ({ publicConfig, path }) => {
    const decision = evaluateRemoteFleetCommandPolicy({
      node: nodeRecord({
        secretRefs: { sshPrivateKey: sshPrivateKeyRef },
        publicConfig,
      }),
      command: connectorCommand(),
    });

    expect(decision).toMatchObject({
      resultType: 'denied',
      reason: 'unsafe-public-config-key',
      path,
    });
  });

  it.each([
    ['https://user:token@node.example.test', 'endpointUrl.credentials'],
    ['https://node.example.test/callback?api_key=plaintext&mode=public', 'endpointUrl'],
    ['https://node.example.test/callback?token=sk-abcdefghi', 'endpointUrl'],
  ])('detects unsafe endpointUrl credential material for %s', (endpointUrl, path) => {
    expect(findUnsafeRemoteFleetEndpointUrlKey(endpointUrl)).toBe(path);
  });

  it('allows runtimeLaunch secretEnv references while still requiring the named node secret refs', () => {
    const decision = evaluateRemoteFleetCommandPolicy({
      node: nodeRecord({
        publicConfig: { runtimeLaunch: { secretEnv: { ANTHROPIC_API_KEY: 'anthropicApiKey' } } },
        secretRefs: { anthropicApiKey: { kind: 'secret-ref', ref: 'vault://remote-fleet/node/anthropic' } },
      }),
      runtime: runtimeRecord({ runtimeKind: 'matcha-agent' }),
      command: { command: 'start-runtime', nodeId: 'node-1', runtimeId: 'runtime-1' },
    });

    expect(decision).toMatchObject({
      resultType: 'allowed',
      commandKind: 'start-runtime',
      requiredSecretRefNames: ['anthropicApiKey'],
      runtimeId: 'runtime-1',
    });
  });

  it('denies public port exposure unless explicitly allowed by policy', () => {
    const node = nodeRecord({
      publicConfig: {
        runtimeLaunch: {
          ports: [{ name: 'app-server', targetPort: 3000, protocol: 'http', exposure: 'public' }],
        },
      },
    });

    const denied = evaluateRemoteFleetCommandPolicy({
      node,
      runtime: runtimeRecord({ runtimeKind: 'matcha-agent' }),
      command: { command: 'start-runtime', nodeId: 'node-1', runtimeId: 'runtime-1' },
    });
    const allowed = evaluateRemoteFleetCommandPolicy({
      node,
      runtime: runtimeRecord({ runtimeKind: 'matcha-agent' }),
      command: { command: 'start-runtime', nodeId: 'node-1', runtimeId: 'runtime-1' },
      policy: { allowPublicPortExposure: true },
    });

    expect(denied).toMatchObject({
      resultType: 'denied',
      reason: 'public-port-exposure-denied',
      exposure: 'public',
      portName: 'app-server',
    });
    expect(allowed).toMatchObject({ resultType: 'allowed', commandKind: 'start-runtime' });
  });

  it('denies node-path workspace mounts unless explicitly allowed by policy', () => {
    const command = {
      command: 'mount-workspace',
      nodeId: 'node-1',
      payload: {
        source: { kind: 'node-path', path: '/srv/workspaces/project' },
        targetPath: '/workspace/project',
        access: 'read-write',
      },
    };

    const denied = evaluateRemoteFleetCommandPolicy({
      node: nodeRecord(),
      command,
    });
    const allowed = evaluateRemoteFleetCommandPolicy({
      node: nodeRecord(),
      command,
      policy: { allowNodePathWorkspaceMounts: true },
    });

    expect(denied).toMatchObject({
      resultType: 'denied',
      reason: 'node-path-workspace-mount-denied',
      commandKind: 'mount-workspace',
    });
    expect(allowed).toMatchObject({ resultType: 'allowed', commandKind: 'mount-workspace' });
  });
});
