import WebSocket from 'ws';
import type { RuntimeHttpClientPort } from '../common/runtime-ports';
import {
  REMOTE_FLEET_SECRET_RESOLVE_PURPOSE_TERMINAL_SESSION,
} from './remote-fleet-secret-host-rpc';
import { evaluateRemoteFleetSecretRefPolicy } from './remote-fleet-secret-policy';
import type { RemoteFleetTerminalSize } from './remote-fleet-terminal-contracts';
import type {
  RemoteFleetTerminalOpenRequest,
  RemoteFleetTerminalProvider,
  RemoteFleetTerminalProviderStreamHandle,
  RemoteFleetTerminalSecretResolver,
} from './remote-fleet-terminal-providers';
import {
  buildK8sApiUrl,
  buildK8sWebSocketUrl,
  k8sPathSegment,
  readRemoteFleetK8sTerminalProviderConfig,
  REMOTE_FLEET_K8S_PROVIDER_KIND,
  type RemoteFleetK8sTerminalConfig,
  type RemoteFleetK8sTerminalProviderConfig,
} from './remote-fleet-k8s-target-config';

const K8S_EXEC_PROTOCOLS = ['v5.channel.k8s.io', 'v4.channel.k8s.io'] as const;
const K8S_CHANNEL_STDIN = 0;
const K8S_CHANNEL_STDOUT = 1;
const K8S_CHANNEL_STDERR = 2;
const K8S_CHANNEL_STATUS = 3;
const K8S_CHANNEL_RESIZE = 4;
const DEFAULT_K8S_EXEC_OPEN_TIMEOUT_MS = 30_000;

export type RemoteFleetTerminalFailureReason =
  | 'unsupported-target'
  | 'invalid-config'
  | 'missing-secret'
  | 'auth'
  | 'network'
  | 'remote-error'
  | 'unavailable';

export type RemoteFleetK8sTerminalOpenResult =
  | {
      readonly resultType: 'opened';
      readonly handle: RemoteFleetTerminalProviderStreamHandle;
      readonly podName: string;
      readonly protocol: string;
      readonly containerName?: string;
    }
  | {
      readonly resultType: 'failed';
      readonly providerKind: typeof REMOTE_FLEET_K8S_PROVIDER_KIND;
      readonly reason: RemoteFleetTerminalFailureReason;
      readonly message: string;
    };

export type RemoteFleetK8sExecStatus =
  | { readonly resultType: 'status'; readonly status: unknown }
  | { readonly resultType: 'error'; readonly message: string };

export interface RemoteFleetTerminalK8sProviderDeps {
  readonly httpClient: RuntimeHttpClientPort;
  readonly secretResolver?: RemoteFleetTerminalSecretResolver;
  readonly webSocketFactory?: RemoteFleetK8sWebSocketFactory;
  readonly webSocketOpenTimeoutMs?: number;
}

export interface RemoteFleetK8sWebSocketFactoryInput {
  readonly url: string;
  readonly protocols: readonly string[];
  readonly headers: Readonly<Record<string, string>>;
}

export type RemoteFleetK8sWebSocketFactory = (input: RemoteFleetK8sWebSocketFactoryInput) => RemoteFleetK8sWebSocket;

export interface RemoteFleetK8sWebSocket {
  readonly protocol?: string;
  send(data: Uint8Array | string): void;
  close(): void;
  on(event: 'open', listener: () => void): this;
  on(event: 'message', listener: (data: WebSocket.RawData) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'close', listener: (code: number, reason: Buffer) => void): this;
}

export interface RemoteFleetK8sTerminalProvider extends RemoteFleetTerminalProvider {
  readonly providerKind: typeof REMOTE_FLEET_K8S_PROVIDER_KIND;
  open(input: RemoteFleetTerminalOpenRequest): Promise<RemoteFleetK8sTerminalOpenResult>;
}

type KubeBearerTokenResult =
  | { readonly resultType: 'resolved'; readonly token: string }
  | { readonly resultType: 'failed'; readonly result: RemoteFleetK8sTerminalOpenResult };

type K8sPodSelectionResult =
  | { readonly resultType: 'selected'; readonly podName: string }
  | { readonly resultType: 'failed'; readonly result: RemoteFleetK8sTerminalOpenResult };

export function createRemoteFleetTerminalK8sProvider(
  deps: RemoteFleetTerminalK8sProviderDeps,
): RemoteFleetK8sTerminalProvider {
  return {
    providerKind: REMOTE_FLEET_K8S_PROVIDER_KIND,
    open: (input) => openK8sTerminal(input, deps),
  };
}

export function encodeK8sTerminalInput(input: string | Uint8Array): Uint8Array {
  return encodeK8sChannelFrame(K8S_CHANNEL_STDIN, toBytes(input));
}

export function encodeK8sTerminalResize(size: RemoteFleetTerminalSize): Uint8Array {
  return encodeK8sChannelFrame(K8S_CHANNEL_RESIZE, new TextEncoder().encode(JSON.stringify({ Width: size.cols, Height: size.rows })));
}

export function decodeK8sTerminalFrame(frame: Uint8Array):
  | { readonly resultType: 'stdout'; readonly chunk: Uint8Array }
  | { readonly resultType: 'stderr'; readonly chunk: Uint8Array }
  | { readonly resultType: 'status'; readonly status: RemoteFleetK8sExecStatus }
  | { readonly resultType: 'ignored' } {
  if (frame.length === 0) return { resultType: 'ignored' };

  const channel = frame[0];
  const payload = frame.slice(1);
  switch (channel) {
    case K8S_CHANNEL_STDOUT:
      return { resultType: 'stdout', chunk: payload };
    case K8S_CHANNEL_STDERR:
      return { resultType: 'stderr', chunk: payload };
    case K8S_CHANNEL_STATUS:
      return { resultType: 'status', status: decodeK8sStatus(payload) };
    default:
      return { resultType: 'ignored' };
  }
}

async function openK8sTerminal(
  input: RemoteFleetTerminalOpenRequest,
  deps: RemoteFleetTerminalK8sProviderDeps,
): Promise<RemoteFleetK8sTerminalOpenResult> {
  const node = input.node;
  if (!node) {
    return failed('invalid-config', 'Kubernetes terminal sessions require a Remote Fleet node configuration.');
  }
  if (node.targetKind !== 'k8s-pod') {
    return failed('unsupported-target', 'Kubernetes terminal provider only supports k8s-pod nodes.');
  }

  const configResult = readRemoteFleetK8sTerminalProviderConfig({
    connectionPublicConfig: input.connection?.publicConfig,
    connectionSecretRefs: input.connection?.secretRefs,
    nodePublicConfig: node.publicConfig,
    nodeSecretRefs: node.secretRefs,
    nodeId: node.id,
  });
  if (configResult.resultType === 'invalid') return failed('invalid-config', configResult.message);

  const secretResolver = input.secretResolver ?? deps.secretResolver;
  if (!secretResolver) {
    return failed('unavailable', 'Kubernetes terminal sessions require a secret resolver for kubeBearerToken.');
  }

  const kubeBearerToken = await readKubeBearerToken(configResult.config, secretResolver, input.session.id);
  if (kubeBearerToken.resultType === 'failed') return kubeBearerToken.result;

  const podSelection = await selectK8sTerminalPod(deps.httpClient, configResult.config, kubeBearerToken.token);
  if (podSelection.resultType === 'failed') return podSelection.result;

  const socketResult = await openK8sExecWebSocket(
    deps.webSocketFactory ?? createWsWebSocket,
    configResult.config,
    podSelection.podName,
    kubeBearerToken.token,
    positiveOrDefault(deps.webSocketOpenTimeoutMs, DEFAULT_K8S_EXEC_OPEN_TIMEOUT_MS),
  );
  if (socketResult.resultType === 'failed') return socketResult.result;

  const handle = new RemoteFleetK8sTerminalStreamHandle(socketResult.socket, {
    podName: podSelection.podName,
    containerName: configResult.config.containerName,
  });
  handle.resize({ rows: input.rows, cols: input.cols });

  return {
    resultType: 'opened',
    handle,
    podName: podSelection.podName,
    protocol: handle.protocol,
    ...(configResult.config.containerName ? { containerName: configResult.config.containerName } : {}),
  };
}

async function readKubeBearerToken(
  config: RemoteFleetK8sTerminalProviderConfig,
  secretResolver: RemoteFleetTerminalSecretResolver,
  terminalSessionId: string,
): Promise<KubeBearerTokenResult> {
  if (!config.kubeBearerTokenSecretRef) {
    return {
      resultType: 'failed',
      result: failed('missing-secret', 'Kubernetes terminal sessions require secretRef kubeBearerToken.'),
    };
  }

  const secretRefPolicy = evaluateRemoteFleetSecretRefPolicy(config.kubeBearerTokenSecretRef);
  if (secretRefPolicy.decision !== 'allowed') {
    return {
      resultType: 'failed',
      result: failed('auth', 'Kubernetes kubeBearerToken secretRef is not allowed by Remote Fleet secret policy.'),
    };
  }

  const readResult = await secretResolver.resolveSecret({
    secretRef: config.kubeBearerTokenSecretRef,
    purpose: REMOTE_FLEET_SECRET_RESOLVE_PURPOSE_TERMINAL_SESSION,
    commandExecutionId: terminalSessionId,
  });
  switch (readResult.resultType) {
    case 'resolved': {
      const token = readResult.plaintextSecretValue.trim();
      if (!token) {
        return {
          resultType: 'failed',
          result: failed('missing-secret', 'Kubernetes kubeBearerToken secret resolved to an empty value.'),
        };
      }
      return { resultType: 'resolved', token };
    }
    case 'notFound':
      return {
        resultType: 'failed',
        result: failed('missing-secret', 'Kubernetes kubeBearerToken secret is missing.'),
      };
    case 'accessDenied':
      return {
        resultType: 'failed',
        result: failed('auth', 'Kubernetes kubeBearerToken secret could not be read due to access policy.'),
      };
    case 'invalidRequest':
      return {
        resultType: 'failed',
        result: failed('invalid-config', 'Kubernetes kubeBearerToken secret resolve request was rejected.'),
      };
    case 'unavailable':
      return {
        resultType: 'failed',
        result: failed('unavailable', 'Kubernetes kubeBearerToken secret resolver is unavailable.'),
      };
  }
}

async function selectK8sTerminalPod(
  httpClient: RuntimeHttpClientPort,
  config: RemoteFleetK8sTerminalConfig,
  kubeBearerToken: string,
): Promise<K8sPodSelectionResult> {
  if (config.podName) return { resultType: 'selected', podName: config.podName };
  if (!config.labelSelector) {
    return {
      resultType: 'failed',
      result: failed('invalid-config', 'Kubernetes terminal sessions require podName or labelSelector.'),
    };
  }

  const response = await requestK8sApi(httpClient, kubeBearerToken, buildK8sPodListUrl(config));
  if (response.resultType === 'failed') return { resultType: 'failed', result: response.result };

  const podName = selectRunningReadyPodName(response.body);
  if (!podName) {
    return {
      resultType: 'failed',
      result: failed('unavailable', 'Kubernetes labelSelector did not match a Running and Ready pod.'),
    };
  }
  return { resultType: 'selected', podName };
}

async function requestK8sApi(
  httpClient: RuntimeHttpClientPort,
  kubeBearerToken: string,
  url: string,
): Promise<
  | { readonly resultType: 'completed'; readonly body: unknown }
  | { readonly resultType: 'failed'; readonly result: RemoteFleetK8sTerminalOpenResult }
> {
  try {
    const response = await httpClient.request(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${kubeBearerToken}`,
      },
    });
    if (!response.ok) {
      return {
        resultType: 'failed',
        result: failed(response.status === 401 || response.status === 403 ? 'auth' : 'remote-error', `Kubernetes API request failed with status ${response.status}.`),
      };
    }
    return { resultType: 'completed', body: await response.json() };
  } catch (error) {
    const errorName = error instanceof Error ? error.name : '';
    return {
      resultType: 'failed',
      result: failed(errorName === 'AbortError' ? 'unavailable' : 'network', 'Kubernetes API request failed before selecting a terminal pod.'),
    };
  }
}

function buildK8sPodListUrl(config: RemoteFleetK8sTerminalConfig): string {
  const path = `/api/v1/namespaces/${k8sPathSegment(config.namespace)}/pods`;
  const url = new URL(buildK8sApiUrl(config.apiServerUrl, path));
  url.searchParams.set('labelSelector', config.labelSelector ?? '');
  return url.toString();
}

function selectRunningReadyPodName(body: unknown): string | undefined {
  if (!isRecord(body) || !Array.isArray(body.items)) return undefined;

  const pod = body.items.find((item) => {
    if (!isRecord(item)) return false;
    const status = isRecord(item.status) ? item.status : undefined;
    return status?.phase === 'Running' && isPodReady(status.conditions);
  });

  if (!isRecord(pod) || !isRecord(pod.metadata) || typeof pod.metadata.name !== 'string') return undefined;
  return pod.metadata.name.trim() || undefined;
}

function isPodReady(conditions: unknown): boolean {
  return Array.isArray(conditions)
    && conditions.some((condition) => isRecord(condition) && condition.type === 'Ready' && condition.status === 'True');
}

function openK8sExecWebSocket(
  webSocketFactory: RemoteFleetK8sWebSocketFactory,
  config: RemoteFleetK8sTerminalConfig,
  podName: string,
  kubeBearerToken: string,
  openTimeoutMs: number,
): Promise<
  | { readonly resultType: 'opened'; readonly socket: RemoteFleetK8sWebSocket }
  | { readonly resultType: 'failed'; readonly result: RemoteFleetK8sTerminalOpenResult }
> {
  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      settle({
        resultType: 'failed',
        result: failed('unavailable', 'Kubernetes exec WebSocket did not open before the timeout.'),
      });
    }, openTimeoutMs);
    const settle = (result: { readonly resultType: 'opened'; readonly socket: RemoteFleetK8sWebSocket } | { readonly resultType: 'failed'; readonly result: RemoteFleetK8sTerminalOpenResult }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };

    let socket: RemoteFleetK8sWebSocket;
    try {
      socket = webSocketFactory({
        url: buildK8sExecUrl(config, podName),
        protocols: K8S_EXEC_PROTOCOLS,
        headers: { Authorization: `Bearer ${kubeBearerToken}` },
      });
    } catch {
      settle({
        resultType: 'failed',
        result: failed('network', 'Kubernetes exec WebSocket could not be created.'),
      });
      return;
    }

    socket.on('open', () => settle({ resultType: 'opened', socket }));
    socket.on('error', () => settle({
      resultType: 'failed',
      result: failed('network', 'Kubernetes exec WebSocket failed before opening.'),
    }));
    socket.on('close', () => settle({
      resultType: 'failed',
      result: failed('network', 'Kubernetes exec WebSocket closed before opening.'),
    }));
  });
}

function buildK8sExecUrl(config: RemoteFleetK8sTerminalConfig, podName: string): string {
  const path = `/api/v1/namespaces/${k8sPathSegment(config.namespace)}/pods/${k8sPathSegment(podName)}/exec`;
  const url = new URL(buildK8sWebSocketUrl(config.apiServerUrl, path));
  url.searchParams.set('stdin', '1');
  url.searchParams.set('stdout', '1');
  url.searchParams.set('stderr', '1');
  url.searchParams.set('tty', '1');
  url.searchParams.set('container', config.containerName ?? '');
  for (const commandPart of config.terminalCommand) {
    url.searchParams.append('command', commandPart);
  }
  return url.toString();
}

function createWsWebSocket(input: RemoteFleetK8sWebSocketFactoryInput): RemoteFleetK8sWebSocket {
  return new WebSocket(input.url, [...input.protocols], { headers: input.headers });
}

class RemoteFleetK8sTerminalStreamHandle implements RemoteFleetTerminalProviderStreamHandle {
  readonly protocol: string;
  readonly podName: string;
  readonly containerName?: string;
  private readonly dataListeners: Array<(chunk: Uint8Array) => void> = [];
  private readonly exitListeners: Array<(event: { readonly exitCode?: number; readonly signal?: string }) => void> = [];
  private readonly errorListeners: Array<(error: Error) => void> = [];
  private closed = false;

  constructor(
    private readonly socket: RemoteFleetK8sWebSocket,
    input: { readonly podName: string; readonly containerName?: string },
  ) {
    this.protocol = socket.protocol ?? '';
    this.podName = input.podName;
    this.containerName = input.containerName;
    socket.on('message', (data) => this.dispatchMessage(data));
    socket.on('close', (code, reason) => this.dispatchExit({ exitCode: code, ...(reason.length > 0 ? { signal: reason.toString('utf8') } : {}) }));
    socket.on('error', () => this.dispatchError(new Error('Kubernetes exec WebSocket error.')));
  }

  write(data: Uint8Array): void {
    if (this.closed) return;
    this.socket.send(encodeK8sTerminalInput(data));
  }

  resize(size: RemoteFleetTerminalSize): void {
    if (this.closed) return;
    this.socket.send(encodeK8sTerminalResize(size));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.close();
  }

  onData(listener: (chunk: Uint8Array) => void): void {
    this.dataListeners.push(listener);
  }

  onExit(listener: (event: { readonly exitCode?: number; readonly signal?: string }) => void): void {
    this.exitListeners.push(listener);
  }

  onError(listener: (error: Error) => void): void {
    this.errorListeners.push(listener);
  }

  private dispatchMessage(data: WebSocket.RawData): void {
    const decoded = decodeK8sTerminalFrame(rawDataToBytes(data));
    switch (decoded.resultType) {
      case 'stdout':
      case 'stderr':
        this.dispatchData(decoded.chunk);
        return;
      case 'status':
        this.dispatchStatus(decoded.status);
        return;
      case 'ignored':
        return;
    }
  }

  private dispatchData(chunk: Uint8Array): void {
    this.dataListeners.forEach((listener) => listener(chunk));
  }

  private dispatchStatus(status: RemoteFleetK8sExecStatus): void {
    if (status.resultType === 'error') {
      this.dispatchError(new Error(status.message || 'Kubernetes exec status payload is invalid.'));
      return;
    }

    const statusRecord = isRecord(status.status) ? status.status : {};
    if (statusRecord.status === 'Success') {
      this.dispatchExit({ exitCode: 0 });
      return;
    }
    if (statusRecord.status === 'Failure') {
      this.dispatchError(new Error(k8sStatusFailureMessage(statusRecord)));
      this.dispatchExit({ exitCode: 1 });
    }
  }

  private dispatchError(error: Error): void {
    this.errorListeners.forEach((listener) => listener(error));
  }

  private dispatchExit(event: { readonly exitCode?: number; readonly signal?: string }): void {
    if (this.closed) return;
    this.closed = true;
    this.exitListeners.forEach((listener) => listener(event));
  }
}

function encodeK8sChannelFrame(channel: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(payload.length + 1);
  frame[0] = channel;
  frame.set(payload, 1);
  return frame;
}

function decodeK8sStatus(payload: Uint8Array): RemoteFleetK8sExecStatus {
  try {
    return { resultType: 'status', status: JSON.parse(new TextDecoder().decode(payload)) };
  } catch {
    return { resultType: 'error', message: new TextDecoder().decode(payload) };
  }
}

function rawDataToBytes(data: WebSocket.RawData): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return Buffer.concat(data).subarray();
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function toBytes(input: string | Uint8Array): Uint8Array {
  return typeof input === 'string' ? new TextEncoder().encode(input) : input;
}

function k8sStatusFailureMessage(status: Readonly<Record<string, unknown>>): string {
  const message = typeof status.message === 'string' && status.message.trim().length > 0
    ? status.message.trim()
    : 'Kubernetes exec status reported failure.';
  return sanitizeErrorMessage(message).slice(0, 500);
}

function sanitizeErrorMessage(message: string): string {
  return message.replace(/\b(bearer|basic)\s+[^"',;&\s]+/gi, '$1 [REDACTED]');
}

function failed(
  reason: RemoteFleetTerminalFailureReason,
  message: string,
): RemoteFleetK8sTerminalOpenResult {
  return {
    resultType: 'failed',
    providerKind: REMOTE_FLEET_K8S_PROVIDER_KIND,
    reason,
    message,
  };
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
