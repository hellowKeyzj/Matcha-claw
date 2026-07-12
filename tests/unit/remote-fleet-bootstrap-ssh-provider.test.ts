import { describe, expect, it, vi } from 'vitest';
import {
  REMOTE_FLEET_BOOTSTRAP_COMMAND_ENVELOPE_VERSION,
  REMOTE_FLEET_CONNECTION_PROBE_ENVELOPE_VERSION,
  bootstrapProviderKindForTargetKind,
  connectionProbeProviderKindForConnectionKind,
  type RemoteFleetBootstrapCommandEnvelope,
  type RemoteFleetBootstrapProviderContext,
  type RemoteFleetBootstrapSecretReadResult,
  type RemoteFleetConnectionProbeEnvelope,
  type RemoteFleetConnectionProbeProvider,
} from '../../runtime-host/application/remote-fleet/remote-fleet-bootstrap';
import {
  REMOTE_FLEET_SSH_BOOTSTRAP_PROVIDER,
  createRemoteFleetSshBootstrapProvider,
} from '../../runtime-host/application/remote-fleet/remote-fleet-bootstrap-ssh-provider';
import type {
  RemoteFleetSshClient,
  RemoteFleetSshClientConnectConfig,
  RemoteFleetSshExecStream,
  RemoteFleetSshShellOptions,
  RemoteFleetSshShellStderrStream,
  RemoteFleetSshShellStream,
} from '../../runtime-host/application/remote-fleet/remote-fleet-terminal-ssh-provider';
import { evaluateRemoteFleetCommandPolicy } from '../../runtime-host/application/remote-fleet/remote-fleet-command-policy';
import type {
  RemoteFleetConnectionRecord,
  RemoteFleetNodeRecord,
  RemoteFleetSecretRef,
  RuntimeAgentRecord,
} from '../../runtime-host/application/remote-fleet/remote-fleet-model';

const now = '2026-07-07T00:00:00.000Z';
const privateKeySecret = '-----BEGIN OPENSSH PRIVATE KEY-----\nprivate-secret-value\n-----END OPENSSH PRIVATE KEY-----';
const sshPasswordSecret = 'remote-fleet-password-secret';
const enrollmentToken = 'mrf_enrollment_secret_token';
const sshPrivateKeyRef: RemoteFleetSecretRef = { kind: 'secret-ref', ref: 'remote-fleet://node-1/ssh-key' };
const sshPasswordRef: RemoteFleetSecretRef = { kind: 'secret-ref', ref: 'remote-fleet://node-1/ssh-password' };

type ClientEvent = 'ready' | 'error' | 'close';
type StreamEvent = 'data' | 'error' | 'exit' | 'close';

class FakeStderrStream implements RemoteFleetSshShellStderrStream {
  private readonly listeners = new Map<'data', Array<(chunk: unknown) => void>>();

  on(event: 'data', listener: (chunk: unknown) => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  emitData(chunk: unknown): void {
    for (const listener of this.listeners.get('data') ?? []) listener(chunk);
  }
}

class FakeShellStream implements RemoteFleetSshShellStream {
  readonly stderr = new FakeStderrStream();
  endCount = 0;
  readonly write = () => undefined;
  readonly setWindow = () => undefined;
  readonly end = () => {
    this.endCount += 1;
  };

  on(_event: 'data', _listener: (chunk: unknown) => void): this;
  on(_event: 'error', _listener: (error: unknown) => void): this;
  on(_event: 'exit', _listener: (code: unknown, signal?: unknown) => void): this;
  on(_event: 'close', _listener: () => void): this;
  on(_event: StreamEvent, _listener: (...args: unknown[]) => void): this {
    return this;
  }
}

class FakeExecStream implements RemoteFleetSshExecStream {
  readonly stderr = new FakeStderrStream();
  endCount = 0;
  private readonly listeners = new Map<StreamEvent, Array<(...args: unknown[]) => void>>();
  readonly end = () => {
    this.endCount += 1;
  };

  on(event: 'data', listener: (chunk: unknown) => void): this;
  on(event: 'error', listener: (error: unknown) => void): this;
  on(event: 'exit', listener: (code: unknown, signal?: unknown) => void): this;
  on(event: 'close', listener: (code?: unknown, signal?: unknown) => void): this;
  on(event: StreamEvent, listener: (...args: unknown[]) => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  emit(event: StreamEvent, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

class FakeSshClient implements RemoteFleetSshClient {
  readonly stream = new FakeShellStream();
  readonly execStream = new FakeExecStream();
  endCount = 0;
  failOnConnect: unknown;
  failOnExec: unknown;
  readonly connect = (config: RemoteFleetSshClientConnectConfig) => {
    this.connectConfig = config;
    if (this.failOnConnect) {
      queueMicrotask(() => this.emit('error', this.failOnConnect));
      return;
    }
    queueMicrotask(() => this.emit('ready'));
  };
  readonly end = () => {
    this.endCount += 1;
  };
  readonly shell = (options: RemoteFleetSshShellOptions, callback: (error: unknown, stream?: RemoteFleetSshShellStream) => void) => {
    this.shellOptions = options;
    callback(undefined, this.stream);
  };
  readonly exec = (command: string, callback: (error: unknown, stream?: RemoteFleetSshExecStream) => void) => {
    this.execCommand = command;
    if (this.failOnExec) {
      callback(this.failOnExec);
      return;
    }
    callback(undefined, this.execStream);
    queueMicrotask(() => {
      for (const chunk of this.execStdout) this.execStream.emit('data', chunk);
      for (const chunk of this.execStderr) this.execStream.stderr.emitData(chunk);
      if (this.execExitSignal) {
        this.execStream.emit('exit', this.execExitCode, this.execExitSignal);
      } else if (this.execExitCode !== undefined) {
        this.execStream.emit('exit', this.execExitCode);
      }
      this.execStream.emit('close');
    });
  };
  connectConfig: RemoteFleetSshClientConnectConfig | undefined;
  shellOptions: RemoteFleetSshShellOptions | undefined;
  execCommand: string | undefined;
  execStdout: unknown[] = ['ready\n'];
  execStderr: unknown[] = [];
  execExitCode: number | undefined = 0;
  execExitSignal: string | undefined;
  private readonly listeners = new Map<ClientEvent, Array<(...args: unknown[]) => void>>();

  on(event: 'ready', listener: () => void): this;
  on(event: 'error', listener: (error: unknown) => void): this;
  on(event: 'close', listener: () => void): this;
  on(event: ClientEvent, listener: (...args: unknown[]) => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  private emit(event: ClientEvent, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

function nodeRecord(overrides: Partial<RemoteFleetNodeRecord> = {}): RemoteFleetNodeRecord {
  return {
    id: 'node-1',
    displayName: 'Node 1',
    targetKind: 'ssh-host',
    endpointUrl: 'ssh://deploy@example.com:2222',
    labels: [],
    enabled: true,
    publicConfig: {},
    secretRefs: { sshPrivateKey: sshPrivateKeyRef },
    health: { reason: 'unknown' },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function connectionRecord(overrides: Partial<RemoteFleetConnectionRecord> = {}): RemoteFleetConnectionRecord {
  return {
    id: 'connection-1',
    displayName: 'Connection 1',
    connectionKind: 'ssh-host',
    endpointUrl: 'ssh://deploy@example.com:2222',
    labels: [],
    enabled: true,
    publicConfig: {},
    secretRefs: { sshPrivateKey: sshPrivateKeyRef },
    health: { reason: 'unknown' },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function connectionProbeEnvelope(
  overrides: Partial<RemoteFleetConnectionProbeEnvelope> = {},
): RemoteFleetConnectionProbeEnvelope {
  return {
    envelopeVersion: REMOTE_FLEET_CONNECTION_PROBE_ENVELOPE_VERSION,
    commandId: 'connection-probe-1',
    idempotencyKey: 'connection-probe-idem-1',
    providerKind: 'ssh',
    connection: connectionRecord(),
    ...overrides,
  };
}

function agentRecord(overrides: Partial<RuntimeAgentRecord> = {}): RuntimeAgentRecord {
  return {
    id: 'agent-1',
    nodeId: 'node-1',
    displayName: 'Agent 1',
    enrollment: { reason: 'installing', commandId: 'cmd-1' },
    capabilities: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function envelope(overrides: Partial<RemoteFleetBootstrapCommandEnvelope> = {}): RemoteFleetBootstrapCommandEnvelope {
  return {
    envelopeVersion: REMOTE_FLEET_BOOTSTRAP_COMMAND_ENVELOPE_VERSION,
    commandId: 'cmd-1',
    idempotencyKey: 'idem-1',
    commandName: 'probe-node',
    providerKind: 'ssh',
    nodeId: 'node-1',
    agentId: 'agent-1',
    node: nodeRecord(),
    agent: agentRecord(),
    ...overrides,
  };
}

function resolvedSecret(secretRefName: string): RemoteFleetBootstrapSecretReadResult {
  if (secretRefName === 'sshPassword') {
    return {
      resultType: 'resolved',
      secretRefName,
      secretRef: sshPasswordRef,
      plaintextSecretValue: sshPasswordSecret,
    };
  }
  return {
    resultType: 'resolved',
    secretRefName,
    secretRef: sshPrivateKeyRef,
    plaintextSecretValue: privateKeySecret,
  };
}

function fakeContext(input: {
  readonly result?: RemoteFleetBootstrapSecretReadResult;
} = {}): RemoteFleetBootstrapProviderContext & { readonly calls: readonly never[] } {
  return {
    calls: [],
    secrets: {
      readSecret: async (secretRefName) => input.result ?? resolvedSecret(secretRefName),
    },
  };
}

describe('Remote Fleet SSH bootstrap provider', () => {
  it('probes SSH connections through the ssh2 client seam without opening a shell or executing a command', async () => {
    const client = new FakeSshClient();
    const context = fakeContext();
    const provider = createRemoteFleetSshBootstrapProvider({ createSshClient: () => client }) as RemoteFleetConnectionProbeProvider;

    const result = await provider.probeConnection(connectionProbeEnvelope(), context);

    expect(result).toEqual({
      resultType: 'completed',
      commandId: 'connection-probe-1',
      providerKind: 'ssh',
    });
    expect(client.connectConfig).toEqual({
      host: 'example.com',
      port: 2222,
      username: 'deploy',
      privateKey: privateKeySecret,
      readyTimeout: 15_000,
    });
    expect(client.shellOptions).toBeUndefined();
    expect(client.execCommand).toBeUndefined();
    expect(client.endCount).toBe(1);
    expect(JSON.stringify(result)).not.toContain(privateKeySecret);
    expect(JSON.stringify(result)).not.toContain(sshPasswordSecret);
  });

  it('probes VM connections as SSH through the ssh2 client seam without opening a shell or executing a command', async () => {
    expect(connectionProbeProviderKindForConnectionKind('vm')).toBe('ssh');
    const client = new FakeSshClient();
    const context = fakeContext();
    const provider = createRemoteFleetSshBootstrapProvider({ createSshClient: () => client }) as RemoteFleetConnectionProbeProvider;

    const result = await provider.probeConnection(connectionProbeEnvelope({
      connection: connectionRecord({
        connectionKind: 'vm',
        endpointUrl: undefined,
        publicConfig: { vm: { host: 'vm.internal', username: 'vmops', port: 2022 } },
        secretRefs: { sshPassword: sshPasswordRef },
      }),
    }), context);

    expect(result).toEqual({
      resultType: 'completed',
      commandId: 'connection-probe-1',
      providerKind: 'ssh',
    });
    expect(client.connectConfig).toEqual({
      host: 'vm.internal',
      port: 2022,
      username: 'vmops',
      password: sshPasswordSecret,
      readyTimeout: 15_000,
    });
    expect(client.shellOptions).toBeUndefined();
    expect(client.execCommand).toBeUndefined();
    expect(client.endCount).toBe(1);
    expect(JSON.stringify(result)).not.toContain(privateKeySecret);
    expect(JSON.stringify(result)).not.toContain(sshPasswordSecret);
  });

  it('classifies connection probe authentication failures without leaking SSH credentials or provider secrets', async () => {
    const client = new FakeSshClient();
    const rawProviderSecret = 'raw-ssh2-provider-secret';
    client.failOnConnect = new Error(
      `Permission denied ${privateKeySecret} ${sshPasswordSecret} ${rawProviderSecret}`,
    );
    const context = fakeContext();
    const provider = createRemoteFleetSshBootstrapProvider({ createSshClient: () => client }) as RemoteFleetConnectionProbeProvider;

    const result = await provider.probeConnection(connectionProbeEnvelope(), context);

    expect(result).toEqual({
      resultType: 'failed',
      commandId: 'connection-probe-1',
      providerKind: 'ssh',
      reason: 'auth',
    });
    expect(client.shellOptions).toBeUndefined();
    expect(client.execCommand).toBeUndefined();
    expect(client.endCount).toBe(1);
    expect(JSON.stringify(result)).not.toContain(privateKeySecret);
    expect(JSON.stringify(result)).not.toContain(sshPasswordSecret);
    expect(JSON.stringify(result)).not.toContain(rawProviderSecret);
  });

  it('rejects delete-environment without resolving secrets or creating an SSH client', async () => {
    const readSecret = vi.fn();
    const createSshClient = vi.fn();
    const provider = createRemoteFleetSshBootstrapProvider({ createSshClient });

    const result = await provider.dispatchCommand(envelope({
      commandName: 'delete-environment',
    }), {
      secrets: { readSecret },
    });

    expect(result).toEqual({
      resultType: 'failed',
      commandId: 'cmd-1',
      providerKind: 'ssh',
      reason: 'unsupported-target',
      message: 'Remote Fleet SSH environment cleanup is not supported.',
    });
    expect(readSecret).not.toHaveBeenCalled();
    expect(createSshClient).not.toHaveBeenCalled();
  });

  it('fails with missing-secret before command execution when sshPrivateKey is absent', async () => {
    const context = fakeContext();

    const result = await REMOTE_FLEET_SSH_BOOTSTRAP_PROVIDER.dispatchCommand(envelope({
      node: nodeRecord({ secretRefs: {} }),
    }), context);

    expect(result).toEqual({
      resultType: 'failed',
      commandId: 'cmd-1',
      providerKind: 'ssh',
      reason: 'missing-secret',
      message: 'Remote Fleet SSH bootstrap requires secretRef sshPrivateKey or sshPassword.',
    });
    expect(context.calls).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain(privateKeySecret);
  });

  it('probes an SSH host through the ssh2 terminal transport without leaking private key material', async () => {
    const client = new FakeSshClient();
    const context = fakeContext();

    const result = await createRemoteFleetSshBootstrapProvider({ createSshClient: () => client })
      .dispatchCommand(envelope(), context);

    expect(result).toEqual({
      resultType: 'completed',
      commandId: 'cmd-1',
      providerKind: 'ssh',
      message: 'Remote Fleet SSH node probe completed.',
    });
    expect(context.calls).toHaveLength(0);
    expect(client.connectConfig).toEqual({
      host: 'example.com',
      port: 2222,
      username: 'deploy',
      privateKey: privateKeySecret,
      readyTimeout: 15_000,
    });
    expect(client.shellOptions).toEqual({ rows: 1, cols: 80, term: 'xterm-256color' });
    expect(client.stream.endCount).toBe(1);
    expect(client.endCount).toBe(1);
    expect(JSON.stringify(result)).not.toContain('private-secret-value');
  });

  it('injects a present enrollment callback URL and redacts the enrollment token from the result', async () => {
    const client = new FakeSshClient();
    client.execStdout = [`installed ${enrollmentToken}`];
    const context = fakeContext();

    const result = await createRemoteFleetSshBootstrapProvider({ createSshClient: () => client }).dispatchCommand(envelope({
      commandName: 'install-agent',
      node: nodeRecord({ publicConfig: { ssh: { host: 'node.internal', username: 'ops', installCommand: 'custom install command' } } }),
      enrollment: {
        agentId: 'agent-1',
        nodeId: 'node-1',
        token: enrollmentToken,
        expiresAt: '2026-07-07T01:00:00.000Z',
        callbackUrl: 'https://runtime-host.example/enroll',
      },
    }), context);

    expect(result).toEqual({
      resultType: 'completed',
      commandId: 'cmd-1',
      providerKind: 'ssh',
      message: 'Remote Fleet SSH RuntimeAgent install command completed.',
      outputSummary: 'installed [redacted]',
    });
    expect(context.calls).toHaveLength(0);
    expect(client.connectConfig).toEqual({
      host: 'node.internal',
      port: 2222,
      username: 'ops',
      privateKey: privateKeySecret,
      readyTimeout: 15_000,
    });
    expect(client.execCommand).toBe(
      `MATCHACLAW_ENROLLMENT_TOKEN='${enrollmentToken}' MATCHACLAW_ENROLLMENT_CALLBACK_URL='https://runtime-host.example/enroll' MATCHACLAW_ENROLLMENT_EXPIRES_AT='2026-07-07T01:00:00.000Z' MATCHACLAW_AGENT_ID='agent-1' MATCHACLAW_NODE_ID='node-1' sh -lc 'custom install command'`,
    );
    expect(client.execCommand).not.toContain(privateKeySecret);
    expect(client.execCommand).not.toContain(sshPasswordSecret);
    expect(client.shellOptions).toBeUndefined();
    expect(client.endCount).toBe(1);
    expect(JSON.stringify(result)).not.toContain(enrollmentToken);
    expect(JSON.stringify(result)).not.toContain('private-secret-value');
  });

  it('uses the default install command with enrollment env injection when publicConfig omits installCommand', async () => {
    const client = new FakeSshClient();
    client.execStdout = ['matchaclaw-runtime-agent-bootstrap-ready'];
    const context = fakeContext();

    await expect(createRemoteFleetSshBootstrapProvider({ createSshClient: () => client }).dispatchCommand(envelope({
      commandName: 'install-agent',
      enrollment: {
        agentId: 'agent-1',
        nodeId: 'node-1',
        token: enrollmentToken,
        expiresAt: '2026-07-07T01:00:00.000Z',
      },
    }), context)).resolves.toMatchObject({ resultType: 'completed' });

    expect(context.calls).toHaveLength(0);
    expect(client.execCommand).toContain(`MATCHACLAW_ENROLLMENT_TOKEN='${enrollmentToken}'`);
    expect(client.execCommand).toContain("MATCHACLAW_ENROLLMENT_EXPIRES_AT='2026-07-07T01:00:00.000Z'");
    expect(client.execCommand).toContain("MATCHACLAW_AGENT_ID='agent-1'");
    expect(client.execCommand).toContain("MATCHACLAW_NODE_ID='node-1'");
    expect(client.execCommand).not.toContain('MATCHACLAW_ENROLLMENT_CALLBACK_URL');
  });

  it('probes password-only SSH through ssh2 without requiring sshpass or plink', async () => {
    const client = new FakeSshClient();
    const context = fakeContext();

    const result = await createRemoteFleetSshBootstrapProvider({ createSshClient: () => client })
      .dispatchCommand(envelope({
        node: nodeRecord({ secretRefs: { sshPassword: sshPasswordRef } }),
      }), context);

    expect(result).toEqual({
      resultType: 'completed',
      commandId: 'cmd-1',
      providerKind: 'ssh',
      message: 'Remote Fleet SSH node probe completed.',
    });
    expect(context.calls).toHaveLength(0);
    expect(client.connectConfig).toEqual({
      host: 'example.com',
      port: 2222,
      username: 'deploy',
      password: sshPasswordSecret,
      readyTimeout: 15_000,
    });
    expect(JSON.stringify(result)).not.toContain(sshPasswordSecret);
  });

  it('runs password install-agent through ssh2 exec without sshpass, plink, or password files', async () => {
    const client = new FakeSshClient();
    client.execStdout = [`installed ${sshPasswordSecret} ${enrollmentToken}`];
    const context = fakeContext();

    const result = await createRemoteFleetSshBootstrapProvider({ createSshClient: () => client }).dispatchCommand(envelope({
      commandName: 'install-agent',
      node: nodeRecord({ secretRefs: { sshPassword: sshPasswordRef } }),
      enrollment: {
        agentId: 'agent-1',
        nodeId: 'node-1',
        token: enrollmentToken,
        expiresAt: '2026-07-07T01:00:00.000Z',
      },
    }), context);

    expect(result).toEqual({
      resultType: 'completed',
      commandId: 'cmd-1',
      providerKind: 'ssh',
      message: 'Remote Fleet SSH RuntimeAgent install command completed.',
      outputSummary: 'installed [redacted] [redacted]',
    });
    expect(context.calls).toHaveLength(0);
    expect(client.connectConfig).toEqual({
      host: 'example.com',
      port: 2222,
      username: 'deploy',
      password: sshPasswordSecret,
      readyTimeout: 15_000,
    });
    expect(client.execCommand).toContain(`MATCHACLAW_ENROLLMENT_TOKEN='${enrollmentToken}'`);
    expect(client.execCommand).not.toContain(sshPasswordSecret);
    expect(JSON.stringify(result)).not.toContain(sshPasswordSecret);
    expect(JSON.stringify(result)).not.toContain(enrollmentToken);
  });

  it('runs VM install-agent through ssh2 exec using publicConfig.vm', async () => {
    const client = new FakeSshClient();
    const context = fakeContext();

    const result = await createRemoteFleetSshBootstrapProvider({ createSshClient: () => client }).dispatchCommand(envelope({
      commandName: 'install-agent',
      node: nodeRecord({
        targetKind: 'vm',
        endpointUrl: undefined,
        publicConfig: { vm: { host: 'vm.internal', username: 'vmops', port: 2022, installCommand: 'vm install command' } },
        secretRefs: { sshPassword: sshPasswordRef },
      }),
      enrollment: {
        agentId: 'agent-1',
        nodeId: 'node-1',
        token: enrollmentToken,
        expiresAt: '2026-07-07T01:00:00.000Z',
      },
    }), context);

    expect(result).toMatchObject({
      resultType: 'completed',
      providerKind: 'ssh',
    });
    expect(context.calls).toHaveLength(0);
    expect(client.connectConfig).toEqual({
      host: 'vm.internal',
      port: 2022,
      username: 'vmops',
      password: sshPasswordSecret,
      readyTimeout: 15_000,
    });
    expect(client.execCommand).toContain('vm install command');
    expect(client.shellOptions).toBeUndefined();
  });

  it('maps non-zero ssh2 exec exits to remote-error without echoing secrets', async () => {
    const client = new FakeSshClient();
    client.execStdout = [`stdout ${enrollmentToken}`];
    client.execStderr = [`stderr ${privateKeySecret}`];
    client.execExitCode = 7;
    const context = fakeContext();

    const result = await createRemoteFleetSshBootstrapProvider({ createSshClient: () => client }).dispatchCommand(envelope({
      commandName: 'install-agent',
      enrollment: {
        agentId: 'agent-1',
        nodeId: 'node-1',
        token: enrollmentToken,
        expiresAt: '2026-07-07T01:00:00.000Z',
      },
    }), context);

    expect(result).toMatchObject({
      resultType: 'failed',
      commandId: 'cmd-1',
      providerKind: 'ssh',
      reason: 'remote-error',
    });
    expect(JSON.stringify(result)).not.toContain(enrollmentToken);
    expect(JSON.stringify(result)).not.toContain('private-secret-value');
  });

  it('maps ssh2 exec startup failures to unavailable without echoing secrets', async () => {
    const client = new FakeSshClient();
    const error = new Error(`Cannot find module ssh2 ${sshPasswordSecret} ${enrollmentToken}`);
    (error as Error & { code: string }).code = 'MODULE_NOT_FOUND';
    client.failOnExec = error;
    const context = fakeContext();

    const result = await createRemoteFleetSshBootstrapProvider({ createSshClient: () => client }).dispatchCommand(envelope({
      commandName: 'install-agent',
      node: nodeRecord({ secretRefs: { sshPassword: sshPasswordRef } }),
      enrollment: {
        agentId: 'agent-1',
        nodeId: 'node-1',
        token: enrollmentToken,
        expiresAt: '2026-07-07T01:00:00.000Z',
      },
    }), context);

    expect(result).toMatchObject({
      resultType: 'failed',
      commandId: 'cmd-1',
      providerKind: 'ssh',
      reason: 'unavailable',
    });
    expect(context.calls).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain(sshPasswordSecret);
    expect(JSON.stringify(result)).not.toContain(enrollmentToken);
  });

  it('maps VM targets to the SSH bootstrap provider and reads publicConfig.vm', async () => {
    expect(bootstrapProviderKindForTargetKind('vm')).toBe('ssh');
    const client = new FakeSshClient();
    const context = fakeContext();

    const result = await createRemoteFleetSshBootstrapProvider({ createSshClient: () => client })
      .dispatchCommand(envelope({
        node: nodeRecord({
          targetKind: 'vm',
          endpointUrl: undefined,
          publicConfig: { vm: { host: 'vm.internal', username: 'vmops', port: 2022 } },
          secretRefs: { sshPassword: sshPasswordRef },
        }),
      }), context);

    expect(result).toMatchObject({
      resultType: 'completed',
      providerKind: 'ssh',
    });
    expect(context.calls).toHaveLength(0);
    expect(client.connectConfig).toEqual({
      host: 'vm.internal',
      port: 2022,
      username: 'vmops',
      password: sshPasswordSecret,
      readyTimeout: 15_000,
    });
    expect(JSON.stringify(result)).not.toContain(sshPasswordSecret);
  });

  it('allows command policy with either sshPrivateKey or sshPassword on SSH and VM nodes', () => {
    expect(evaluateRemoteFleetCommandPolicy({
      node: nodeRecord({ secretRefs: { sshPrivateKey: sshPrivateKeyRef } }),
      command: { kind: 'install-agent', nodeId: 'node-1' },
    })).toMatchObject({
      resultType: 'allowed',
      requiredSecretRefNames: ['sshPrivateKey'],
    });

    expect(evaluateRemoteFleetCommandPolicy({
      node: nodeRecord({ secretRefs: { sshPassword: sshPasswordRef } }),
      command: { kind: 'install-agent', nodeId: 'node-1' },
    })).toMatchObject({
      resultType: 'allowed',
      requiredSecretRefNames: ['sshPassword'],
    });

    expect(evaluateRemoteFleetCommandPolicy({
      node: nodeRecord({ targetKind: 'vm', secretRefs: { sshPassword: sshPasswordRef } }),
      command: { kind: 'install-agent', nodeId: 'node-1' },
    })).toMatchObject({
      resultType: 'allowed',
      requiredSecretRefNames: ['sshPassword'],
    });

    expect(evaluateRemoteFleetCommandPolicy({
      node: nodeRecord({ secretRefs: {} }),
      command: { kind: 'install-agent', nodeId: 'node-1' },
    })).toMatchObject({
      resultType: 'denied',
      reason: 'missing-auth-secret-ref',
      message: 'Remote Fleet command install-agent requires node secretRef sshPrivateKey or sshPassword.',
    });
  });

  it('rejects publicConfig and endpointUrl credential leaks before command execution', async () => {
    const context = fakeContext();

    await expect(REMOTE_FLEET_SSH_BOOTSTRAP_PROVIDER.dispatchCommand(envelope({
      node: nodeRecord({ publicConfig: { ssh: { host: 'example.com', password: 'plaintext' } } }),
    }), context)).resolves.toMatchObject({
      resultType: 'failed',
      reason: 'invalid-config',
      message: 'Remote Fleet publicConfig must not contain plaintext credential key publicConfig.ssh.password.',
    });

    await expect(REMOTE_FLEET_SSH_BOOTSTRAP_PROVIDER.dispatchCommand(envelope({
      node: nodeRecord({ endpointUrl: 'ssh://deploy:secret@example.com' }),
    }), context)).resolves.toMatchObject({
      resultType: 'failed',
      reason: 'invalid-config',
      message: 'Remote Fleet SSH endpointUrl must not include a password.',
    });

    await expect(REMOTE_FLEET_SSH_BOOTSTRAP_PROVIDER.dispatchCommand(envelope({
      node: nodeRecord({ endpointUrl: undefined, publicConfig: { ssh: { host: '-oProxyCommand=unsafe' } } }),
    }), context)).resolves.toMatchObject({
      resultType: 'failed',
      reason: 'invalid-config',
      message: 'Remote Fleet SSH host must be a hostname or IP address without credentials.',
    });
    expect(context.calls).toHaveLength(0);
  });

  it('maps SSH authentication failures to failed auth without echoing secrets', async () => {
    const client = new FakeSshClient();
    client.failOnConnect = new Error(`Permission denied ${privateKeySecret} ${enrollmentToken}`);
    const context = fakeContext();

    const result = await createRemoteFleetSshBootstrapProvider({ createSshClient: () => client }).dispatchCommand(envelope({
      commandName: 'install-agent',
      enrollment: {
        agentId: 'agent-1',
        nodeId: 'node-1',
        token: enrollmentToken,
        expiresAt: '2026-07-07T01:00:00.000Z',
      },
    }), context);

    expect(result).toMatchObject({
      resultType: 'failed',
      commandId: 'cmd-1',
      providerKind: 'ssh',
      reason: 'auth',
    });
    expect(context.calls).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain(enrollmentToken);
    expect(JSON.stringify(result)).not.toContain('private-secret-value');
  });
});
