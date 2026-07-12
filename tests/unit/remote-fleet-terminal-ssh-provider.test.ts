import { describe, expect, it, vi } from 'vitest';
import {
  createRemoteFleetSshTerminalProvider,
  createRemoteFleetVmTerminalProvider,
  type RemoteFleetSecretResolveRequestInput,
  type RemoteFleetSshClient,
  type RemoteFleetSshClientConnectConfig,
  type RemoteFleetSshExecStream,
  type RemoteFleetSshShellOptions,
  type RemoteFleetSshShellStderrStream,
  type RemoteFleetSshShellStream,
} from '../../runtime-host/application/remote-fleet';
import type {
  RemoteFleetNodeRecord,
  RemoteFleetSecretRef,
  RemoteFleetTerminalSessionSummary,
} from '../../runtime-host/application/remote-fleet/remote-fleet-model';
import type { RemoteFleetTerminalOpenRequest } from '../../runtime-host/application/remote-fleet/remote-fleet-terminal-providers';

const now = '2026-07-08T00:00:00.000Z';
const privateKeySecret = '-----BEGIN OPENSSH PRIVATE KEY-----\nprivate-secret-value\n-----END OPENSSH PRIVATE KEY-----';
const sshPasswordSecret = 'remote-fleet-password-secret';
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
  readonly write = vi.fn();
  readonly setWindow = vi.fn();
  readonly end = vi.fn();
  private readonly listeners = new Map<StreamEvent, Array<(...args: unknown[]) => void>>();

  on(event: 'data', listener: (chunk: unknown) => void): this;
  on(event: 'error', listener: (error: unknown) => void): this;
  on(event: 'exit', listener: (code: unknown, signal?: unknown) => void): this;
  on(event: 'close', listener: () => void): this;
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
  failOnConnect: unknown;
  readonly connect = vi.fn((config: RemoteFleetSshClientConnectConfig) => {
    this.connectConfig = config;
    if (this.failOnConnect) {
      queueMicrotask(() => this.emit('error', this.failOnConnect));
      return;
    }
    if (this.autoReady) queueMicrotask(() => this.emit('ready'));
  });
  readonly end = vi.fn();
  readonly shell = vi.fn((options: RemoteFleetSshShellOptions, callback: (error: unknown, stream?: RemoteFleetSshShellStream) => void) => {
    this.shellOptions = options;
    callback(undefined, this.stream);
  });
  readonly exec = vi.fn((_command: string, callback: (error: unknown, stream?: RemoteFleetSshExecStream) => void) => {
    callback(new Error('exec is not used by terminal shell tests'));
  });
  connectConfig: RemoteFleetSshClientConnectConfig | undefined;
  shellOptions: RemoteFleetSshShellOptions | undefined;
  private readonly listeners = new Map<ClientEvent, Array<(...args: unknown[]) => void>>();

  constructor(private readonly autoReady = true) {}

  on(event: 'ready', listener: () => void): this;
  on(event: 'error', listener: (error: unknown) => void): this;
  on(event: 'close', listener: () => void): this;
  on(event: ClientEvent, listener: (...args: unknown[]) => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  emit(event: ClientEvent, ...args: unknown[]): void {
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

function terminalSession(node: RemoteFleetNodeRecord): RemoteFleetTerminalSessionSummary {
  return {
    id: 'terminal-1',
    nodeId: node.id,
    targetKind: node.targetKind,
    status: 'opening',
    createdAt: now,
    updatedAt: now,
  };
}

function openRequest(input: {
  readonly node?: RemoteFleetNodeRecord;
  readonly connection?: RemoteFleetTerminalOpenRequest['connection'];
  readonly rows?: number;
  readonly cols?: number;
  readonly term?: string;
  readonly resolveSecret?: (input: RemoteFleetSecretResolveRequestInput) => ReturnType<typeof resolveSecret> | Promise<ReturnType<typeof resolveSecret>>;
} = {}): RemoteFleetTerminalOpenRequest {
  const node = input.node ?? nodeRecord();
  return {
    session: terminalSession(node),
    node,
    ...(input.connection ? { connection: input.connection } : {}),
    rows: input.rows ?? 24,
    cols: input.cols ?? 80,
    secretResolver: { resolveSecret: input.resolveSecret ?? resolveSecret },
    ...(input.term ? { term: input.term } : {}),
  } as RemoteFleetTerminalOpenRequest;
}

function resolveSecret(input: RemoteFleetSecretResolveRequestInput) {
  if (input.secretRef === sshPasswordRef.ref) {
    return { resultType: 'resolved' as const, secretRef: input.secretRef, plaintextSecretValue: sshPasswordSecret };
  }
  return { resultType: 'resolved' as const, secretRef: input.secretRef, plaintextSecretValue: privateKeySecret };
}

async function openWithReady(input: {
  readonly node?: RemoteFleetNodeRecord;
  readonly client?: FakeSshClient;
  readonly rows?: number;
  readonly cols?: number;
  readonly term?: string;
} = {}) {
  const client = input.client ?? new FakeSshClient();
  const result = await createRemoteFleetSshTerminalProvider({ createSshClient: () => client }).open(openRequest({
    node: input.node,
    rows: input.rows,
    cols: input.cols,
    term: input.term,
  }));
  return { result, client };
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

describe('Remote Fleet SSH terminal provider', () => {
  it('opens a private-key SSH shell through ssh2 without leaking key material', async () => {
    const { result, client } = await openWithReady({ rows: 40, cols: 120, term: 'xterm-direct' });

    expect(result.resultType).toBe('opened');
    expect(client.connectConfig).toEqual({
      host: 'example.com',
      port: 2222,
      username: 'deploy',
      privateKey: privateKeySecret,
      readyTimeout: 15_000,
    });
    expect(client.shellOptions).toEqual({ rows: 40, cols: 120, term: 'xterm-direct' });
    expect(JSON.stringify(result)).not.toContain('private-secret-value');
    expect(JSON.stringify(result)).not.toContain(privateKeySecret);
  });

  it('uses linked Connection config and secret refs for an empty derived SSH node', async () => {
    const connectionPrivateKeyRef: RemoteFleetSecretRef = {
      kind: 'secret-ref',
      ref: 'remote-fleet://connection-ssh-1/ssh-key',
    };
    const derivedNode = nodeRecord({
      endpointUrl: undefined,
      publicConfig: {},
      secretRefs: {},
    });
    const connection = {
      id: 'connection-ssh-1',
      displayName: 'SSH Bastion connection',
      connectionKind: 'ssh-host' as const,
      endpointUrl: 'ssh://ops@bastion.example.internal:2201',
      labels: [],
      enabled: true,
      publicConfig: {
        ssh: {
          host: 'bastion.example.internal',
          port: 2201,
          username: 'ops',
        },
      },
      secretRefs: { sshPrivateKey: connectionPrivateKeyRef },
      health: { reason: 'unknown' as const },
      createdAt: now,
      updatedAt: now,
    };
    const resolveSecretMock = vi.fn((input: RemoteFleetSecretResolveRequestInput) => ({
      resultType: 'resolved' as const,
      secretRef: input.secretRef,
      plaintextSecretValue: privateKeySecret,
    }));
    const client = new FakeSshClient();

    const result = await createRemoteFleetSshTerminalProvider({ createSshClient: () => client }).open(openRequest({
      node: derivedNode,
      connection,
      resolveSecret: resolveSecretMock,
    }));

    expect(result.resultType).toBe('opened');
    expect(resolveSecretMock).toHaveBeenCalledWith({
      secretRef: connectionPrivateKeyRef.ref,
      purpose: 'terminal-session',
      commandExecutionId: 'terminal-1',
    });
    expect(client.connectConfig).toEqual({
      host: 'bastion.example.internal',
      port: 2201,
      username: 'ops',
      privateKey: privateKeySecret,
      readyTimeout: 15_000,
    });
    expect(JSON.stringify(result)).not.toContain(privateKeySecret);
    expect(JSON.stringify(result)).not.toContain(connectionPrivateKeyRef.ref);
  });

  it('forwards shell data, stderr/error, exit, resize, write and close through the stream handle', async () => {
    const { result, client } = await openWithReady();
    expect(result.resultType).toBe('opened');
    if (result.resultType !== 'opened') throw new Error('expected opened terminal');

    const data: string[] = [];
    const errors: string[] = [];
    const exits: unknown[] = [];
    result.handle.onData((chunk) => data.push(text(chunk)));
    result.handle.onError((error) => errors.push(error.message));
    result.handle.onExit((event) => exits.push(event));

    result.handle.write(new TextEncoder().encode('ls -la\n'));
    result.handle.resize({ rows: 50, cols: 140 });
    client.stream.emit('data', Buffer.from('hello'));
    client.stream.stderr.emitData('warning');
    client.stream.emit('error', new Error(`bad ${privateKeySecret}`));
    client.stream.emit('exit', 7, 'SIGTERM');
    client.stream.emit('close');

    expect(client.stream.write).toHaveBeenCalledWith(new TextEncoder().encode('ls -la\n'));
    expect(client.stream.setWindow).toHaveBeenCalledWith(50, 140, 0, 0);
    expect(client.stream.end).toHaveBeenCalledTimes(0);
    expect(client.end).toHaveBeenCalledTimes(1);
    expect(data).toEqual(['hello', 'warning']);
    expect(errors).toEqual(['bad [redacted]']);
    expect(exits).toEqual([{ exitCode: 7, signal: 'SIGTERM' }]);
  });

  it('closes the shell stream and ssh2 client when caller closes the handle', async () => {
    const { result, client } = await openWithReady();
    expect(result.resultType).toBe('opened');
    if (result.resultType !== 'opened') throw new Error('expected opened terminal');

    result.handle.close();
    result.handle.write(new TextEncoder().encode('after-close'));
    result.handle.resize({ rows: 20, cols: 80 });

    expect(client.stream.end).toHaveBeenCalledTimes(1);
    expect(client.end).toHaveBeenCalledTimes(1);
    expect(client.stream.write).not.toHaveBeenCalledWith(new TextEncoder().encode('after-close'));
    expect(client.stream.setWindow).not.toHaveBeenCalled();
  });

  it('uses password auth only in ssh2 connect config and reads publicConfig.vm for VM targets', async () => {
    const node = nodeRecord({
      targetKind: 'vm',
      endpointUrl: undefined,
      publicConfig: { vm: { host: 'vm.internal', username: 'vmops', port: 2022 } },
      secretRefs: { sshPassword: sshPasswordRef },
    });
    const client = new FakeSshClient();

    const result = await createRemoteFleetVmTerminalProvider({ createSshClient: () => client }).open(openRequest({ node }));

    expect(result.resultType).toBe('opened');
    expect(result).toMatchObject({ providerKind: 'vm' });
    expect(client.connectConfig).toEqual({
      host: 'vm.internal',
      port: 2022,
      username: 'vmops',
      password: sshPasswordSecret,
      readyTimeout: 15_000,
    });
    expect(JSON.stringify(result)).not.toContain(sshPasswordSecret);
  });

  it('resolves terminal-session secret purpose for sshPassword and returns actionable notFound', async () => {
    const resolveSecretMock = vi.fn((_input: RemoteFleetSecretResolveRequestInput) => ({
      resultType: 'notFound' as const,
      secretRef: sshPasswordRef.ref,
    }));

    const result = await createRemoteFleetSshTerminalProvider({ createSshClient: () => new FakeSshClient() }).open(openRequest({
      node: nodeRecord({ secretRefs: { sshPassword: sshPasswordRef } }),
      resolveSecret: resolveSecretMock,
    }));

    expect(resolveSecretMock).toHaveBeenCalledWith({
      secretRef: sshPasswordRef.ref,
      purpose: 'terminal-session',
      commandExecutionId: 'terminal-1',
    });
    expect(result).toEqual({
      resultType: 'failed',
      providerKind: 'ssh',
      reason: 'notFound',
      message: 'Remote Fleet SSH terminal secretRef sshPassword was not found.',
    });
    expect(JSON.stringify(result)).not.toContain(sshPasswordSecret);
  });

  it.each([
    ['missing secretRef', {}, 'missing-secret', 'Remote Fleet SSH terminal requires secretRef sshPrivateKey or sshPassword.'],
    ['access denied', { resultType: 'accessDenied' as const, secretRef: sshPrivateKeyRef.ref }, 'accessDenied', 'Remote Fleet SSH terminal secretRef sshPrivateKey access was denied.'],
    ['resolver unavailable', { resultType: 'unavailable' as const }, 'unavailable', 'Remote Fleet SSH terminal secret resolver is unavailable.'],
  ])('returns actionable secret error for %s', async (_name, readResult, reason, message) => {
    const result = await createRemoteFleetSshTerminalProvider({ createSshClient: () => new FakeSshClient() }).open(openRequest({
      node: nodeRecord(_name === 'missing secretRef' ? { secretRefs: {} } : {}),
      resolveSecret: () => readResult as ReturnType<typeof resolveSecret>,
    }));

    expect(result).toEqual({
      resultType: 'failed',
      providerKind: 'ssh',
      reason,
      message,
    });
    expect(JSON.stringify(result)).not.toContain(privateKeySecret);
    expect(JSON.stringify(result)).not.toContain(sshPasswordSecret);
  });

  it('redacts secrets from SSH errors and does not expose them in summaries', async () => {
    const client = new FakeSshClient(false);
    client.failOnConnect = new Error(`Permission denied ${privateKeySecret}`);
    const result = await createRemoteFleetSshTerminalProvider({ createSshClient: () => client }).open(openRequest());

    expect(result).toMatchObject({
      resultType: 'failed',
      providerKind: 'ssh',
      reason: 'auth',
    });
    expect(JSON.stringify(result)).not.toContain('private-secret-value');
    expect(JSON.stringify(result)).not.toContain(privateKeySecret);
  });
});
