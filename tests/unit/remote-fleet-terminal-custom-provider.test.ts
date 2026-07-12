import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { RemoteFleetNodeRecord, RemoteFleetSecretRef, RemoteFleetSnapshot, RemoteRuntimeEndpointRecord } from '../../runtime-host/application/remote-fleet/remote-fleet-model';
import type { RemoteFleetTerminalOpenRequest, RemoteFleetTerminalSecretResolver } from '../../runtime-host/application/remote-fleet/remote-fleet-terminal-providers';
import {
  REMOTE_FLEET_CUSTOM_TERMINAL_ATTACH_OPERATION_ID,
  REMOTE_FLEET_CUSTOM_TERMINAL_PROTOCOL_VERSION,
  createRemoteFleetCustomTerminalProvider,
  readRemoteFleetCustomTerminalConfig,
  type RemoteFleetCustomTerminalWebSocket,
  type RemoteFleetCustomTerminalWebSocketFactoryInput,
} from '../../runtime-host/application/remote-fleet';

const now = '2026-07-08T00:00:00.000Z';
const customBearerToken = 'custom-terminal-token-super-secret';
const customCredentialRef: RemoteFleetSecretRef = { kind: 'secret-ref', ref: 'remote-fleet://node-custom/custom-terminal-token' };

class MockCustomWebSocket extends EventEmitter implements RemoteFleetCustomTerminalWebSocket {
  readonly sent: Array<Uint8Array | string> = [];
  closed = false;

  send(data: Uint8Array | string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.emit('open');
  }

  receiveBinary(data: Uint8Array): void {
    this.emit('message', data, true);
  }

  receiveControl(frame: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(frame)), false);
  }

  disconnect(code = 1000, reason = ''): void {
    this.emit('close', code, Buffer.from(reason));
  }
}

function nodeRecord(overrides: Partial<RemoteFleetNodeRecord> = {}): RemoteFleetNodeRecord {
  return {
    id: 'node-custom',
    displayName: 'Custom Terminal Node',
    targetKind: 'custom',
    labels: [],
    enabled: true,
    publicConfig: {
      custom: {
        terminal: {
          transport: 'websocket',
          endpointUrl: 'wss://terminal.example.test/attach',
          protocolVersion: REMOTE_FLEET_CUSTOM_TERMINAL_PROTOCOL_VERSION,
          credentialRefName: 'customTerminalToken',
        },
      },
    },
    secretRefs: {
      customTerminalToken: customCredentialRef,
    },
    health: { reason: 'unknown' },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function endpointRecord(overrides: Partial<RemoteRuntimeEndpointRecord> = {}): RemoteRuntimeEndpointRecord {
  return {
    id: 'endpoint-custom',
    nodeId: 'node-custom',
    runtimeId: 'runtime-custom',
    endpointRef: {
      kind: 'native-runtime',
      runtimeAdapterId: 'remote-fleet',
      runtimeInstanceId: 'runtime-custom',
    },
    scope: {
      kind: 'runtime-instance',
      endpoint: {
        kind: 'native-runtime',
        runtimeAdapterId: 'remote-fleet',
        runtimeInstanceId: 'runtime-custom',
      },
    },
    protocol: 'remote-fleet',
    labels: [],
    health: { reason: 'ready', lastProbeAt: now },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function snapshot(overrides: Partial<RemoteFleetSnapshot> = {}): Pick<RemoteFleetSnapshot, 'capabilities'> {
  return {
    capabilities: [
      {
        id: 'endpoint-custom:capabilities',
        nodeId: 'node-custom',
        runtimeId: 'runtime-custom',
        endpointId: 'endpoint-custom',
        displayName: 'Custom terminal capability',
        operationIds: [REMOTE_FLEET_CUSTOM_TERMINAL_ATTACH_OPERATION_ID],
        status: 'current',
      },
    ],
    ...overrides,
  };
}

function openRequest(overrides: Partial<RemoteFleetTerminalOpenRequest> = {}): RemoteFleetTerminalOpenRequest {
  const node = overrides.node ?? nodeRecord();
  const endpoint = overrides.endpoint ?? endpointRecord();
  return {
    session: {
      id: 'terminal-session-custom',
      nodeId: node.id,
      runtimeId: 'runtime-custom',
      endpointId: endpoint.id,
      targetKind: node.targetKind,
      status: 'opening',
      createdAt: now,
      updatedAt: now,
    },
    node,
    endpoint,
    rows: 24,
    cols: 80,
    ...overrides,
  };
}

function createSecretResolver(secretValue = customBearerToken): RemoteFleetTerminalSecretResolver & {
  readonly resolveSecret: ReturnType<typeof vi.fn>;
} {
  return {
    resolveSecret: vi.fn(async () => ({
      resultType: 'resolved' as const,
      plaintextSecretValue: secretValue,
    })),
  };
}

function openTerminalWithMockSocket(input: {
  readonly request?: RemoteFleetTerminalOpenRequest;
  readonly secretResolver?: RemoteFleetTerminalSecretResolver;
  readonly socket?: MockCustomWebSocket;
  readonly factoryCalls?: RemoteFleetCustomTerminalWebSocketFactoryInput[];
  readonly capabilitySnapshot?: Pick<RemoteFleetSnapshot, 'capabilities'>;
} = {}) {
  const socket = input.socket ?? new MockCustomWebSocket();
  const factoryCalls = input.factoryCalls ?? [];
  const provider = createRemoteFleetCustomTerminalProvider({
    capabilityReader: { readSnapshot: () => input.capabilitySnapshot ?? snapshot() },
    secretResolver: input.secretResolver ?? createSecretResolver(),
    webSocketFactory: (factoryInput) => {
      factoryCalls.push(factoryInput);
      queueMicrotask(() => socket.open());
      return socket;
    },
  });
  return {
    socket,
    factoryCalls,
    resultPromise: provider.open(input.request ?? openRequest()),
  };
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function expectJsonDoesNotLeakSecrets(value: unknown, secrets: readonly string[]): void {
  const textValue = JSON.stringify(value);
  for (const secret of secrets) {
    expect(textValue).not.toContain(secret);
  }
}

describe('Remote Fleet custom terminal provider', () => {
  it('opens a capability-gated websocket relay with bearer auth only in headers', async () => {
    const secretResolver = createSecretResolver();
    const { resultPromise, factoryCalls } = openTerminalWithMockSocket({ secretResolver });

    const result = await resultPromise;

    expect(result.resultType).toBe('opened');
    expect(secretResolver.resolveSecret).toHaveBeenCalledWith({
      secretRef: customCredentialRef.ref,
      purpose: 'terminal-session',
      commandExecutionId: 'terminal-session-custom',
    });
    expect(factoryCalls).toHaveLength(1);
    expect(factoryCalls[0].url).toBe('wss://terminal.example.test/attach');
    expect(factoryCalls[0].protocols).toEqual([REMOTE_FLEET_CUSTOM_TERMINAL_PROTOCOL_VERSION]);
    expect(factoryCalls[0].headers).toEqual({
      Authorization: `Bearer ${customBearerToken}`,
      'X-Remote-Fleet-Terminal-Session-Id': 'terminal-session-custom',
      'X-Remote-Fleet-Node-Id': 'node-custom',
      'X-Remote-Fleet-Endpoint-Id': 'endpoint-custom',
      'X-Remote-Fleet-Terminal-Rows': '24',
      'X-Remote-Fleet-Terminal-Cols': '80',
    });
    expect(factoryCalls[0].url).not.toContain(customBearerToken);
    expectJsonDoesNotLeakSecrets(result, [customBearerToken]);
  });

  it('passes binary data and JSON resize close frames through the relay', async () => {
    const socket = new MockCustomWebSocket();
    const { resultPromise } = openTerminalWithMockSocket({ socket });
    const result = await resultPromise;
    expect(result.resultType).toBe('opened');
    if (result.resultType !== 'opened') throw new Error('expected opened terminal');

    const data: string[] = [];
    const errors: string[] = [];
    const exits: unknown[] = [];
    result.handle.onData((chunk) => data.push(text(chunk)));
    result.handle.onError((error) => errors.push(error.message));
    result.handle.onExit((event) => exits.push(event));

    result.handle.write(new TextEncoder().encode('pwd\n'));
    result.handle.resize({ rows: 40, cols: 120 });
    socket.receiveBinary(new TextEncoder().encode('hello'));
    socket.receiveControl({ type: 'terminal.error', sessionId: 'terminal-session-custom', message: 'remote failed' });
    socket.receiveControl({ type: 'terminal.exit', sessionId: 'terminal-session-custom', exitCode: 7, signal: 'SIGTERM' });

    expect(text(socket.sent[0] as Uint8Array)).toBe('pwd\n');
    expect(JSON.parse(socket.sent[1] as string)).toEqual({ type: 'terminal.resize', rows: 40, cols: 120 });
    expect(data).toEqual(['hello']);
    expect(errors).toEqual(['remote failed']);
    expect(exits).toEqual([{ exitCode: 7, signal: 'SIGTERM' }]);

    expect(socket.closed).toBe(true);
  });

  it('sends terminal.close when caller closes the relay handle', async () => {
    const socket = new MockCustomWebSocket();
    const { resultPromise } = openTerminalWithMockSocket({ socket });
    const result = await resultPromise;
    expect(result.resultType).toBe('opened');
    if (result.resultType !== 'opened') throw new Error('expected opened terminal');

    result.handle.close();

    expect(JSON.parse(socket.sent[0] as string)).toEqual({ type: 'terminal.close', reason: 'closed by host' });
    expect(socket.closed).toBe(true);
  });

  it('rejects missing current attach capability before opening websocket or resolving credentials', async () => {
    const secretResolver = createSecretResolver();
    const factoryCalls: RemoteFleetCustomTerminalWebSocketFactoryInput[] = [];
    const provider = createRemoteFleetCustomTerminalProvider({
      capabilityReader: { readSnapshot: () => snapshot({ capabilities: [{ ...snapshot().capabilities[0], operationIds: [], status: 'current' }] }) },
      secretResolver,
      webSocketFactory: (factoryInput) => {
        factoryCalls.push(factoryInput);
        return new MockCustomWebSocket();
      },
    });

    const result = await provider.open(openRequest());

    expect(result).toMatchObject({
      resultType: 'failed',
      providerKind: 'custom',
      reason: 'unsupported',
    });
    expect(factoryCalls).toHaveLength(0);
    expect(secretResolver.resolveSecret).not.toHaveBeenCalled();
    expectJsonDoesNotLeakSecrets(result, [customBearerToken]);
  });

  it('rejects endpoint that is not ready before opening websocket', async () => {
    const { resultPromise, factoryCalls } = openTerminalWithMockSocket({
      request: openRequest({ endpoint: endpointRecord({ health: { reason: 'unhealthy', message: 'probe failed' } }) }),
    });

    const result = await resultPromise;

    expect(result).toMatchObject({ resultType: 'failed', providerKind: 'custom', reason: 'unsupported' });
    expect(factoryCalls).toHaveLength(0);
  });

  it('rejects invalid publicConfig.custom.terminal without opening websocket', async () => {
    const { resultPromise, factoryCalls } = openTerminalWithMockSocket({
      request: openRequest({
        node: nodeRecord({
          publicConfig: {
            custom: {
              terminal: {
                transport: 'websocket',
                endpointUrl: 'wss://user:secret@terminal.example.test/attach?token=secret',
                protocolVersion: REMOTE_FLEET_CUSTOM_TERMINAL_PROTOCOL_VERSION,
              },
            },
          },
        }),
      }),
    });

    const result = await resultPromise;

    expect(result).toMatchObject({ resultType: 'failed', providerKind: 'custom', reason: 'invalid-config' });
    expect(factoryCalls).toHaveLength(0);
    expectJsonDoesNotLeakSecrets(result, ['secret', 'token=']);
  });

  it('resolves credentialRefName from node.secretRefs and returns safe secret errors', async () => {
    const secretResolver = createSecretResolver();
    const { resultPromise, factoryCalls } = openTerminalWithMockSocket({
      secretResolver,
      request: openRequest({ node: nodeRecord({ secretRefs: {} }) }),
    });

    const result = await resultPromise;

    expect(result).toMatchObject({ resultType: 'failed', providerKind: 'custom', reason: 'missing-secret' });
    expect(factoryCalls).toHaveLength(0);
    expect(secretResolver.resolveSecret).not.toHaveBeenCalled();
    expectJsonDoesNotLeakSecrets(result, [customBearerToken]);
  });

  it('rejects non-loopback plaintext custom terminal endpoints', async () => {
    expect(readRemoteFleetCustomTerminalConfig({
      custom: {
        terminal: {
          transport: 'websocket',
          endpointUrl: 'ws://terminal.example.test/attach',
          protocolVersion: REMOTE_FLEET_CUSTOM_TERMINAL_PROTOCOL_VERSION,
        },
      },
    })).toMatchObject({ resultType: 'invalid' });
  });

  it('allows loopback credential-less relay config and parses the strict config shape', async () => {
    expect(readRemoteFleetCustomTerminalConfig({
      custom: {
        terminal: {
          transport: 'websocket',
          endpointUrl: 'ws://127.0.0.1/attach',
          protocolVersion: REMOTE_FLEET_CUSTOM_TERMINAL_PROTOCOL_VERSION,
        },
      },
    })).toEqual({
      resultType: 'valid',
      config: {
        transport: 'websocket',
        endpointUrl: 'ws://127.0.0.1/attach',
        protocolVersion: REMOTE_FLEET_CUSTOM_TERMINAL_PROTOCOL_VERSION,
      },
    });

    const factoryCalls: RemoteFleetCustomTerminalWebSocketFactoryInput[] = [];
    const { resultPromise } = openTerminalWithMockSocket({
      factoryCalls,
      secretResolver: createSecretResolver(),
      request: openRequest({
        node: nodeRecord({
          publicConfig: {
            custom: {
              terminal: {
                transport: 'websocket',
                endpointUrl: 'ws://127.0.0.1/attach',
                protocolVersion: REMOTE_FLEET_CUSTOM_TERMINAL_PROTOCOL_VERSION,
              },
            },
          },
          secretRefs: {},
        }),
      }),
    });

    const result = await resultPromise;

    expect(result.resultType).toBe('opened');
    expect(factoryCalls[0].headers).not.toHaveProperty('Authorization');
  });
});
