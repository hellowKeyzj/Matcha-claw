import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeHttpClientPort, RuntimeHttpResponse } from '../../runtime-host/application/common/runtime-ports';
import type { RemoteFleetNodeRecord, RemoteFleetSecretRef } from '../../runtime-host/application/remote-fleet/remote-fleet-model';
import type { RemoteFleetTerminalOpenRequest } from '../../runtime-host/application/remote-fleet/remote-fleet-terminal-providers';
import type { RemoteFleetTerminalSecretResolver } from '../../runtime-host/application/remote-fleet/remote-fleet-terminal-providers';
import {
  createRemoteFleetTerminalK8sProvider,
  decodeK8sTerminalFrame,
  encodeK8sTerminalInput,
  encodeK8sTerminalResize,
  type RemoteFleetK8sWebSocket,
  type RemoteFleetK8sWebSocketFactoryInput,
} from '../../runtime-host/application/remote-fleet/remote-fleet-terminal-k8s-provider';
import { readRemoteFleetK8sTerminalProviderConfig } from '../../runtime-host/application/remote-fleet/remote-fleet-k8s-target-config';

const kubeBearerToken = 'kube-bearer-token-super-secret';
const kubeBearerTokenRef: RemoteFleetSecretRef = { kind: 'secret-ref', ref: 'remote-fleet://node-1/kube-bearer-token' };

type RecordedHttpCall = {
  readonly url: string;
  readonly init?: RequestInit;
};

type RecordingHttpClient = RuntimeHttpClientPort & {
  readonly calls: RecordedHttpCall[];
};

class MockK8sWebSocket extends EventEmitter implements RemoteFleetK8sWebSocket {
  readonly sent: Array<Uint8Array | string> = [];
  closed = false;

  constructor(readonly protocol = 'v5.channel.k8s.io') {
    super();
  }

  send(data: Uint8Array | string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.emit('open');
  }

  receive(data: Uint8Array): void {
    this.emit('message', data);
  }

  fail(error = new Error('socket failed with hidden token')): void {
    this.emit('error', error);
  }

  disconnect(code = 1000, reason = ''): void {
    this.emit('close', code, Buffer.from(reason));
  }
}

function runtimeHttpResponse(input: {
  readonly status?: number;
  readonly ok?: boolean;
  readonly body?: unknown;
  readonly text?: string;
} = {}): RuntimeHttpResponse {
  const status = input.status ?? 200;
  const body = input.body ?? {};
  return {
    ok: input.ok ?? (status >= 200 && status < 300),
    status,
    json: async () => body,
    text: async () => input.text ?? JSON.stringify(body),
  };
}

function createRecordingHttpClient(
  respond: (call: RecordedHttpCall) => RuntimeHttpResponse | Promise<RuntimeHttpResponse> = () => runtimeHttpResponse(),
): RecordingHttpClient {
  const calls: RecordedHttpCall[] = [];
  return {
    calls,
    request: vi.fn(async (url, init) => {
      const call = { url, init };
      calls.push(call);
      return await respond(call);
    }),
  };
}

function createSecretResolver(secretValue = kubeBearerToken): RemoteFleetTerminalSecretResolver & {
  readonly resolveSecret: ReturnType<typeof vi.fn>;
} {
  return {
    resolveSecret: vi.fn(async () => ({
      resultType: 'resolved' as const,
      plaintextSecretValue: secretValue,
    })),
  };
}

function nodeRecord(overrides: Partial<RemoteFleetNodeRecord> = {}): RemoteFleetNodeRecord {
  return {
    id: 'node-1',
    displayName: 'K8s Node',
    targetKind: 'k8s-pod',
    labels: [],
    enabled: true,
    publicConfig: {
      k8s: {
        apiServerUrl: 'https://k8s.example.test:6443',
        namespace: 'runtime-agents',
        podName: 'runtime-agent-pod-1',
        containerName: 'runtime-agent',
        terminal: { command: ['/bin/sh', '-lc', 'exec bash'] },
      },
    },
    secretRefs: {
      kubeBearerToken: kubeBearerTokenRef,
    },
    health: { reason: 'unknown' },
    createdAt: '2026-07-08T00:00:00.000Z',
    updatedAt: '2026-07-08T00:00:00.000Z',
    ...overrides,
  };
}

function openRequest(overrides: Partial<RemoteFleetTerminalOpenRequest> = {}): RemoteFleetTerminalOpenRequest {
  const node = overrides.node ?? nodeRecord();
  return {
    session: {
      id: 'terminal-session-1',
      nodeId: node.id,
      targetKind: node.targetKind,
      status: 'opening',
      createdAt: '2026-07-08T00:00:00.000Z',
      updatedAt: '2026-07-08T00:00:00.000Z',
    },
    node,
    rows: 24,
    cols: 80,
    ...overrides,
  };
}

function headerValue(init: RequestInit | undefined, headerName: string): string | undefined {
  const headers = init?.headers;
  if (!headers) return undefined;
  if (typeof Headers !== 'undefined' && headers instanceof Headers) return headers.get(headerName) ?? undefined;
  if (Array.isArray(headers)) return headers.find(([name]) => name.toLowerCase() === headerName.toLowerCase())?.[1];
  const record = headers as Record<string, string>;
  const matchingName = Object.keys(record).find((name) => name.toLowerCase() === headerName.toLowerCase());
  return matchingName ? record[matchingName] : undefined;
}

function openTerminalWithMockSocket(input: {
  readonly request?: RemoteFleetTerminalOpenRequest;
  readonly httpClient?: RecordingHttpClient;
  readonly secretResolver?: RemoteFleetTerminalSecretResolver;
  readonly socket?: MockK8sWebSocket;
  readonly factoryCalls?: RemoteFleetK8sWebSocketFactoryInput[];
}) {
  const socket = input.socket ?? new MockK8sWebSocket();
  const factoryCalls = input.factoryCalls ?? [];
  const provider = createRemoteFleetTerminalK8sProvider({
    httpClient: input.httpClient ?? createRecordingHttpClient(),
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

function frame(channel: number, payload: string): Uint8Array {
  const encoded = new TextEncoder().encode(payload);
  const output = new Uint8Array(encoded.length + 1);
  output[0] = channel;
  output.set(encoded, 1);
  return output;
}

function expectJsonDoesNotLeakSecrets(value: unknown, secrets: readonly string[]): void {
  const textValue = JSON.stringify(value);
  for (const secret of secrets) {
    expect(textValue).not.toContain(secret);
  }
}

describe('Remote Fleet Kubernetes terminal provider', () => {
  it('merges shared connection endpoint/auth with separate Kubernetes terminal environments', () => {
    const connectionPublicConfig = {
      k8s: {
        apiServerUrl: 'https://shared-k8s.example.test:6443',
        defaultNamespace: 'shared-runtime-agents',
      },
    };
    const connectionSecretRefs = {
      kubeBearerToken: { kind: 'secret-ref', ref: 'remote-fleet://connection-1/kube-bearer-token' },
    };

    const blueConfig = readRemoteFleetK8sTerminalProviderConfig({
      connectionPublicConfig,
      connectionSecretRefs,
      nodePublicConfig: {
        k8s: {
          apiServerUrl: 'https://node-blue-k8s.example.test:6443',
          namespace: 'blue-runtime-agents',
          podName: 'blue-runtime-agent-pod',
          terminal: { command: ['sh'] },
        },
      },
      nodeSecretRefs: {
        kubeBearerToken: { kind: 'secret-ref', ref: 'remote-fleet://node-blue/kube-bearer-token' },
      },
      nodeId: 'node-blue',
    });
    const greenConfig = readRemoteFleetK8sTerminalProviderConfig({
      connectionPublicConfig,
      connectionSecretRefs,
      nodePublicConfig: {
        k8s: {
          namespace: 'green-runtime-agents',
          podName: 'green-runtime-agent-pod',
          terminal: { command: ['bash'] },
        },
      },
      nodeId: 'node-green',
    });

    expect(blueConfig).toMatchObject({
      resultType: 'valid',
      config: {
        apiServerUrl: 'https://shared-k8s.example.test:6443',
        namespace: 'blue-runtime-agents',
        podName: 'blue-runtime-agent-pod',
        terminalCommand: ['sh'],
        kubeBearerTokenSecretRef: 'remote-fleet://connection-1/kube-bearer-token',
      },
    });
    expect(greenConfig).toMatchObject({
      resultType: 'valid',
      config: {
        apiServerUrl: 'https://shared-k8s.example.test:6443',
        namespace: 'green-runtime-agents',
        podName: 'green-runtime-agent-pod',
        terminalCommand: ['bash'],
        kubeBearerTokenSecretRef: 'remote-fleet://connection-1/kube-bearer-token',
      },
    });
    if (blueConfig.resultType !== 'valid' || greenConfig.resultType !== 'valid') throw new Error('expected valid configs');
    expect(blueConfig.config.namespace).not.toBe(greenConfig.config.namespace);
    expect(blueConfig.config.podName).not.toBe(greenConfig.config.podName);
  });

  it('opens Kubernetes exec WebSocket with bearer auth in headers and command in URL query', async () => {
    const secretResolver = createSecretResolver();
    const { resultPromise, factoryCalls } = openTerminalWithMockSocket({ secretResolver });

    const result = await resultPromise;

    expect(result.resultType).toBe('opened');
    expect(secretResolver.resolveSecret).toHaveBeenCalledWith({
      secretRef: kubeBearerTokenRef.ref,
      purpose: 'terminal-session',
      commandExecutionId: 'terminal-session-1',
    });
    expect(factoryCalls).toHaveLength(1);
    expect(factoryCalls[0].headers).toEqual({ Authorization: `Bearer ${kubeBearerToken}` });
    expect(factoryCalls[0].protocols).toEqual(['v5.channel.k8s.io', 'v4.channel.k8s.io']);

    const url = new URL(factoryCalls[0].url);
    expect(url.protocol).toBe('wss:');
    expect(url.origin).toBe('wss://k8s.example.test:6443');
    expect(url.pathname).toBe('/api/v1/namespaces/runtime-agents/pods/runtime-agent-pod-1/exec');
    expect(url.searchParams.get('stdin')).toBe('1');
    expect(url.searchParams.get('stdout')).toBe('1');
    expect(url.searchParams.get('stderr')).toBe('1');
    expect(url.searchParams.get('tty')).toBe('1');
    expect(url.searchParams.get('container')).toBe('runtime-agent');
    expect(url.searchParams.getAll('command')).toEqual(['/bin/sh', '-lc', 'exec bash']);
    expect(factoryCalls[0].url).not.toContain(kubeBearerToken);
    expectJsonDoesNotLeakSecrets(result, [kubeBearerToken]);
  });

  it('rejects unsafe Kubernetes connection publicConfig without leaking token material', () => {
    const result = readRemoteFleetK8sTerminalProviderConfig({
      connectionPublicConfig: {
        k8s: {
          apiServerUrl: 'https://k8s.example.test:6443',
          kubeBearerToken: 'super-secret',
        },
      },
      connectionSecretRefs: {
        kubeBearerToken: { kind: 'secret-ref', ref: 'remote-fleet://connection-1/kube-bearer-token' },
      },
      nodePublicConfig: {
        k8s: {
          podName: 'runtime-agent-pod-1',
          terminal: { command: 'sh' },
        },
      },
      nodeId: 'node-1',
    });

    expect(result).toMatchObject({
      resultType: 'invalid',
      message: 'Remote Fleet Kubernetes connection publicConfig contains unsafe credential material at publicConfig.k8s.kubeBearerToken.',
    });
    expectJsonDoesNotLeakSecrets(result, ['super-secret']);
  });

  it('selects the first Running and Ready pod by labelSelector before opening exec', async () => {
    const httpClient = createRecordingHttpClient(() => runtimeHttpResponse({
      body: {
        items: [
          {
            metadata: { name: 'pending-pod' },
            status: { phase: 'Pending', conditions: [{ type: 'Ready', status: 'True' }] },
          },
          {
            metadata: { name: 'running-not-ready' },
            status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'False' }] },
          },
          {
            metadata: { name: 'running-ready' },
            status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
          },
        ],
      },
    }));
    const request = openRequest({
      node: nodeRecord({
        publicConfig: {
          k8s: {
            apiServerUrl: 'https://k8s.example.test:6443',
            namespace: 'runtime-agents',
            labelSelector: 'app=matchaclaw-runtime-agent,node=node-1',
            terminal: { command: 'sh' },
          },
        },
      }),
    });
    const { resultPromise, factoryCalls } = openTerminalWithMockSocket({ request, httpClient });

    const result = await resultPromise;

    expect(result.resultType).toBe('opened');
    expect(httpClient.calls).toHaveLength(1);
    const podListUrl = new URL(httpClient.calls[0].url);
    expect(podListUrl.pathname).toBe('/api/v1/namespaces/runtime-agents/pods');
    expect(podListUrl.searchParams.get('labelSelector')).toBe('app=matchaclaw-runtime-agent,node=node-1');
    expect(headerValue(httpClient.calls[0].init, 'authorization')).toBe(`Bearer ${kubeBearerToken}`);
    expect(httpClient.calls[0].url).not.toContain(kubeBearerToken);
    const execUrl = new URL(factoryCalls[0].url);
    expect(execUrl.pathname).toBe('/api/v1/namespaces/runtime-agents/pods/running-ready/exec');
    expect(execUrl.searchParams.get('container')).toBe('');
  });

  it('defaults pod discovery and shell for Matcha-managed Kubernetes targets', async () => {
    const httpClient = createRecordingHttpClient(() => runtimeHttpResponse({
      body: {
        items: [
          { metadata: { name: 'managed-runtime-agent' }, status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } },
        ],
      },
    }));
    const request = openRequest({
      node: nodeRecord({
        id: 'Node 1',
        publicConfig: {
          k8s: {
            apiServerUrl: 'https://k8s.example.test:6443',
            namespace: 'runtime-agents',
          },
        },
      }),
    });
    const { resultPromise, factoryCalls } = openTerminalWithMockSocket({ request, httpClient });

    const result = await resultPromise;

    expect(result.resultType).toBe('opened');
    const podListUrl = new URL(httpClient.calls[0].url);
    expect(podListUrl.searchParams.get('labelSelector')).toBe('app.kubernetes.io/name=matchaclaw-runtime-agent,matchaclaw.ai/node-id=node-1');
    const execUrl = new URL(factoryCalls[0].url);
    expect(execUrl.pathname).toBe('/api/v1/namespaces/runtime-agents/pods/managed-runtime-agent/exec');
    expect(execUrl.searchParams.getAll('command')).toEqual(['/bin/sh', '-l']);
  });

  it('returns unavailable when labelSelector has no Running and Ready pod', async () => {
    const httpClient = createRecordingHttpClient(() => runtimeHttpResponse({
      body: {
        items: [
          { metadata: { name: 'not-ready' }, status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'False' }] } },
        ],
      },
    }));
    const request = openRequest({
      node: nodeRecord({
        publicConfig: {
          k8s: {
            apiServerUrl: 'https://k8s.example.test:6443',
            namespace: 'runtime-agents',
            labelSelector: 'app=missing',
            terminal: { command: 'sh' },
          },
        },
      }),
    });
    const factoryCalls: RemoteFleetK8sWebSocketFactoryInput[] = [];
    const provider = createRemoteFleetTerminalK8sProvider({
      httpClient,
      secretResolver: createSecretResolver(),
      webSocketFactory: (factoryInput) => {
        factoryCalls.push(factoryInput);
        return new MockK8sWebSocket();
      },
    });

    const result = await provider.open(request);

    expect(result).toMatchObject({
      resultType: 'failed',
      providerKind: 'k8s',
      reason: 'unavailable',
    });
    expect(factoryCalls).toHaveLength(0);
    expectJsonDoesNotLeakSecrets(result, [kubeBearerToken]);
  });

  it('encodes stdin and resize channel frames and decodes stdout stderr status frames', async () => {
    expect([...encodeK8sTerminalInput('ls')]).toEqual([0, ...new TextEncoder().encode('ls')]);
    const resizeFrame = encodeK8sTerminalResize({ cols: 120, rows: 40 });
    expect(resizeFrame[0]).toBe(4);
    expect(JSON.parse(text(resizeFrame.slice(1)))).toEqual({ Width: 120, Height: 40 });

    expect(decodeK8sTerminalFrame(frame(1, 'out'))).toMatchObject({ resultType: 'stdout' });
    expect(text(decodeK8sTerminalFrame(frame(1, 'out')).resultType === 'stdout'
      ? decodeK8sTerminalFrame(frame(1, 'out')).chunk
      : new Uint8Array())).toBe('out');
    expect(decodeK8sTerminalFrame(frame(2, 'err'))).toMatchObject({ resultType: 'stderr' });
    expect(decodeK8sTerminalFrame(frame(3, '{"status":"Success"}'))).toEqual({
      resultType: 'status',
      status: { resultType: 'status', status: { status: 'Success' } },
    });
  });

  it('wires session channel frames to listeners and sends channel 4 JSON resize', async () => {
    const socket = new MockK8sWebSocket('v4.channel.k8s.io');
    const { resultPromise } = openTerminalWithMockSocket({ socket });
    const result = await resultPromise;
    expect(result.resultType).toBe('opened');
    if (result.resultType !== 'opened') throw new Error('expected opened session');

    const data: string[] = [];
    const exits: unknown[] = [];
    result.handle.onData((chunk) => data.push(text(chunk)));
    result.handle.onExit((event) => exits.push(event));

    result.handle.write(new TextEncoder().encode('pwd'));
    result.handle.resize({ cols: 80, rows: 24 });
    socket.receive(frame(1, 'hello'));
    socket.receive(frame(2, 'warn'));
    socket.receive(frame(3, '{"status":"Success"}'));

    expect(socket.sent[0]).toEqual(encodeK8sTerminalResize({ rows: 24, cols: 80 }));
    expect(socket.sent[1]).toEqual(encodeK8sTerminalInput(new TextEncoder().encode('pwd')));
    const sentResize = socket.sent[2];
    expect(sentResize).toBeInstanceOf(Uint8Array);
    expect((sentResize as Uint8Array)[0]).toBe(4);
    expect(JSON.parse(text((sentResize as Uint8Array).slice(1)))).toEqual({ Width: 80, Height: 24 });
    expect(data).toEqual(['hello', 'warn']);
    expect(exits).toEqual([{ exitCode: 0 }]);
    expect(result.protocol).toBe('v4.channel.k8s.io');
  });

  it('requires kubeBearerToken without placing token material in URL or errors', async () => {
    const factoryCalls: RemoteFleetK8sWebSocketFactoryInput[] = [];
    const provider = createRemoteFleetTerminalK8sProvider({
      httpClient: createRecordingHttpClient(),
      secretResolver: createSecretResolver(),
      webSocketFactory: (factoryInput) => {
        factoryCalls.push(factoryInput);
        return new MockK8sWebSocket();
      },
    });

    const result = await provider.open(openRequest({ node: nodeRecord({ secretRefs: {} }) }));

    expect(result).toMatchObject({
      resultType: 'failed',
      providerKind: 'k8s',
      reason: 'missing-secret',
    });
    expect(factoryCalls).toHaveLength(0);
    expectJsonDoesNotLeakSecrets(result, [kubeBearerToken]);
  });

  it('rejects unsafe API URL and pod path segment before resolving secrets', async () => {
    const secretResolver = createSecretResolver();
    const provider = createRemoteFleetTerminalK8sProvider({
      httpClient: createRecordingHttpClient(),
      secretResolver,
      webSocketFactory: () => new MockK8sWebSocket(),
    });

    const urlResult = await provider.open(openRequest({
      node: nodeRecord({
        publicConfig: {
          k8s: {
            apiServerUrl: 'https://admin:super-secret@k8s.example.test:6443?token=super-secret',
            podName: 'runtime-agent-pod-1',
            terminal: { command: 'sh' },
          },
        },
      }),
    }));
    const podResult = await provider.open(openRequest({
      node: nodeRecord({
        publicConfig: {
          k8s: {
            apiServerUrl: 'https://k8s.example.test:6443',
            podName: '../pod',
            terminal: { command: 'sh' },
          },
        },
      }),
    }));

    expect(urlResult).toMatchObject({ resultType: 'failed', reason: 'invalid-config' });
    expect(podResult).toMatchObject({ resultType: 'failed', reason: 'invalid-config' });
    expect(secretResolver.resolveSecret).not.toHaveBeenCalled();
    expectJsonDoesNotLeakSecrets(urlResult, ['super-secret', 'token=', 'admin:']);
    expectJsonDoesNotLeakSecrets(podResult, [kubeBearerToken]);
  });
});
