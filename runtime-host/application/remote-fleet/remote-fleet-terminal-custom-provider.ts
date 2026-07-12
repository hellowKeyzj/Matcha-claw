import WebSocket from 'ws';
import type { RemoteFleetSnapshot } from './remote-fleet-model';
import {
  REMOTE_FLEET_SECRET_RESOLVE_PURPOSE_TERMINAL_SESSION,
} from './remote-fleet-secret-host-rpc';
import { evaluateRemoteFleetSecretRefPolicy } from './remote-fleet-secret-policy';
import type {
  RemoteFleetTerminalControlFrame,
  RemoteFleetTerminalSize,
} from './remote-fleet-terminal-contracts';
import type {
  RemoteFleetTerminalExitEvent,
  RemoteFleetTerminalOpenRequest,
  RemoteFleetTerminalProvider,
  RemoteFleetTerminalProviderStreamHandle,
  RemoteFleetTerminalSecretResolver,
} from './remote-fleet-terminal-providers';
import {
  REMOTE_FLEET_CUSTOM_TERMINAL_ATTACH_OPERATION_ID,
  REMOTE_FLEET_CUSTOM_TERMINAL_PROVIDER_KIND,
  REMOTE_FLEET_CUSTOM_TERMINAL_PROTOCOL_VERSION,
  readRemoteFleetCustomTerminalConfig,
} from './remote-fleet-custom-terminal-config';

const DEFAULT_CUSTOM_TERMINAL_OPEN_TIMEOUT_MS = 30_000;

export type RemoteFleetCustomTerminalFailureReason =
  | 'unsupported'
  | 'invalid-config'
  | 'missing-secret'
  | 'accessDenied'
  | 'notFound'
  | 'unavailable'
  | 'network'
  | 'remote-error';

export type RemoteFleetCustomTerminalOpenResult =
  | {
      readonly resultType: 'opened';
      readonly providerKind: typeof REMOTE_FLEET_CUSTOM_TERMINAL_PROVIDER_KIND;
      readonly handle: RemoteFleetTerminalProviderStreamHandle;
      readonly protocolVersion: typeof REMOTE_FLEET_CUSTOM_TERMINAL_PROTOCOL_VERSION;
    }
  | {
      readonly resultType: 'failed';
      readonly providerKind: typeof REMOTE_FLEET_CUSTOM_TERMINAL_PROVIDER_KIND;
      readonly reason: RemoteFleetCustomTerminalFailureReason;
      readonly message: string;
    };

export interface RemoteFleetCustomTerminalCapabilityReader {
  readSnapshot(): Promise<Pick<RemoteFleetSnapshot, 'capabilities'> | undefined> | Pick<RemoteFleetSnapshot, 'capabilities'> | undefined;
}

export interface RemoteFleetCustomTerminalWebSocketFactoryInput {
  readonly url: string;
  readonly protocols: readonly string[];
  readonly headers: Readonly<Record<string, string>>;
}

export type RemoteFleetCustomTerminalWebSocketFactory = (input: RemoteFleetCustomTerminalWebSocketFactoryInput) => RemoteFleetCustomTerminalWebSocket;

export interface RemoteFleetCustomTerminalWebSocket {
  send(data: Uint8Array | string): void;
  close(): void;
  on(event: 'open', listener: () => void): this;
  on(event: 'message', listener: (data: WebSocket.RawData, isBinary: boolean) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'close', listener: (code: number, reason: Buffer) => void): this;
}

export interface RemoteFleetCustomTerminalProviderDeps {
  readonly capabilityReader: RemoteFleetCustomTerminalCapabilityReader;
  readonly secretResolver?: RemoteFleetTerminalSecretResolver;
  readonly webSocketFactory?: RemoteFleetCustomTerminalWebSocketFactory;
  readonly webSocketOpenTimeoutMs?: number;
}

export interface RemoteFleetCustomTerminalProvider extends RemoteFleetTerminalProvider {
  readonly providerKind: typeof REMOTE_FLEET_CUSTOM_TERMINAL_PROVIDER_KIND;
  open(input: RemoteFleetTerminalOpenRequest): Promise<RemoteFleetCustomTerminalOpenResult>;
}

type CustomTerminalCredentialResult =
  | { readonly resultType: 'resolved'; readonly authorizationHeader?: string }
  | { readonly resultType: 'failed'; readonly result: RemoteFleetCustomTerminalOpenResult };

export function createRemoteFleetCustomTerminalProvider(
  deps: RemoteFleetCustomTerminalProviderDeps,
): RemoteFleetCustomTerminalProvider {
  return {
    providerKind: REMOTE_FLEET_CUSTOM_TERMINAL_PROVIDER_KIND,
    open: (input) => openCustomTerminal(input, deps),
  };
}

async function openCustomTerminal(
  input: RemoteFleetTerminalOpenRequest,
  deps: RemoteFleetCustomTerminalProviderDeps,
): Promise<RemoteFleetCustomTerminalOpenResult> {
  const node = input.node;
  if (!node) {
    return failed('invalid-config', 'Remote Fleet custom terminal sessions require a Remote Fleet node configuration.');
  }
  if (node.targetKind !== 'custom') {
    return failed('unsupported', 'Remote Fleet custom terminal provider only supports custom nodes.');
  }
  const endpoint = input.endpoint;
  if (!endpoint) {
    return failed('unsupported', 'Remote Fleet custom terminal sessions require a ready endpoint.');
  }
  if (endpoint.health.reason !== 'ready') {
    return failed('unsupported', 'Remote Fleet custom terminal endpoint must be ready.');
  }

  const capabilityGate = await validateCustomTerminalCapability(input, deps.capabilityReader);
  if (capabilityGate.resultType === 'failed') return capabilityGate.result;

  const configResult = readRemoteFleetCustomTerminalConfig(node.publicConfig);
  if (configResult.resultType === 'invalid') {
    return failed('invalid-config', configResult.message);
  }

  const credential = await readCustomTerminalCredential(input, input.secretResolver ?? deps.secretResolver, configResult.config.credentialRefName);
  if (credential.resultType === 'failed') return credential.result;

  const socketResult = await openCustomTerminalWebSocket(
    deps.webSocketFactory ?? createWsWebSocket,
    {
      url: configResult.config.endpointUrl,
      authorizationHeader: credential.authorizationHeader,
      rows: input.rows,
      cols: input.cols,
      sessionId: input.session.id,
      nodeId: node.id,
      endpointId: endpoint.id,
    },
    positiveOrDefault(deps.webSocketOpenTimeoutMs, DEFAULT_CUSTOM_TERMINAL_OPEN_TIMEOUT_MS),
  );
  if (socketResult.resultType === 'failed') return socketResult.result;

  return {
    resultType: 'opened',
    providerKind: REMOTE_FLEET_CUSTOM_TERMINAL_PROVIDER_KIND,
    handle: new RemoteFleetCustomTerminalStreamHandle(socketResult.socket),
    protocolVersion: REMOTE_FLEET_CUSTOM_TERMINAL_PROTOCOL_VERSION,
  };
}

async function validateCustomTerminalCapability(
  input: RemoteFleetTerminalOpenRequest,
  capabilityReader: RemoteFleetCustomTerminalCapabilityReader,
): Promise<
  | { readonly resultType: 'supported' }
  | { readonly resultType: 'failed'; readonly result: RemoteFleetCustomTerminalOpenResult }
> {
  const endpointId = input.endpoint?.id;
  if (!endpointId) {
    return { resultType: 'failed', result: failed('unsupported', 'Remote Fleet custom terminal sessions require a capability endpoint.') };
  }

  let snapshot: Pick<RemoteFleetSnapshot, 'capabilities'> | undefined;
  try {
    snapshot = await capabilityReader.readSnapshot();
  } catch {
    return { resultType: 'failed', result: failed('unavailable', 'Remote Fleet custom terminal capability snapshot is unavailable.') };
  }

  const capability = snapshot?.capabilities.find((candidate) => candidate.endpointId === endpointId);
  if (!capability || capability.status !== 'current') {
    return { resultType: 'failed', result: failed('unsupported', 'Remote Fleet custom terminal requires a current capability snapshot.') };
  }
  if (!capability.operationIds.includes(REMOTE_FLEET_CUSTOM_TERMINAL_ATTACH_OPERATION_ID)) {
    return { resultType: 'failed', result: failed('unsupported', 'Remote Fleet custom terminal capability does not include remoteFleet.terminal.attach.') };
  }

  return { resultType: 'supported' };
}

async function readCustomTerminalCredential(
  input: RemoteFleetTerminalOpenRequest,
  secretResolver: RemoteFleetTerminalSecretResolver | undefined,
  credentialRefName: string | undefined,
): Promise<CustomTerminalCredentialResult> {
  if (!credentialRefName) {
    return { resultType: 'resolved' };
  }

  const secretRef = input.node?.secretRefs[credentialRefName];
  if (secretRef?.kind !== 'secret-ref' || secretRef.ref.trim().length === 0) {
    return {
      resultType: 'failed',
      result: failed('missing-secret', `Remote Fleet custom terminal requires node secretRef ${credentialRefName}.`),
    };
  }
  const secretRefPolicy = evaluateRemoteFleetSecretRefPolicy(secretRef.ref);
  if (secretRefPolicy.decision !== 'allowed') {
    return {
      resultType: 'failed',
      result: failed('accessDenied', `Remote Fleet custom terminal secretRef ${credentialRefName} access was denied.`),
    };
  }
  if (!secretResolver) {
    return {
      resultType: 'failed',
      result: failed('unavailable', 'Remote Fleet custom terminal secret resolver is unavailable.'),
    };
  }

  let readResult: Awaited<ReturnType<RemoteFleetTerminalSecretResolver['resolveSecret']>>;
  try {
    readResult = await secretResolver.resolveSecret({
      secretRef: secretRef.ref,
      purpose: REMOTE_FLEET_SECRET_RESOLVE_PURPOSE_TERMINAL_SESSION,
      commandExecutionId: input.session.id,
    });
  } catch {
    return {
      resultType: 'failed',
      result: failed('unavailable', 'Remote Fleet custom terminal secret resolver is unavailable.'),
    };
  }

  switch (readResult.resultType) {
    case 'resolved': {
      const token = readResult.plaintextSecretValue.trim();
      if (!token) {
        return { resultType: 'failed', result: failed('missing-secret', 'Remote Fleet custom terminal credential secret is empty.') };
      }
      return { resultType: 'resolved', authorizationHeader: `Bearer ${token}` };
    }
    case 'notFound':
      return { resultType: 'failed', result: failed('notFound', `Remote Fleet custom terminal secretRef ${credentialRefName} was not found.`) };
    case 'accessDenied':
      return { resultType: 'failed', result: failed('accessDenied', `Remote Fleet custom terminal secretRef ${credentialRefName} access was denied.`) };
    case 'invalidRequest':
      return { resultType: 'failed', result: failed('invalid-config', 'Remote Fleet custom terminal secret resolve request was rejected.') };
    case 'unavailable':
      return { resultType: 'failed', result: failed('unavailable', 'Remote Fleet custom terminal secret resolver is unavailable.') };
  }
}

function openCustomTerminalWebSocket(
  webSocketFactory: RemoteFleetCustomTerminalWebSocketFactory,
  input: {
    readonly url: string;
    readonly authorizationHeader?: string;
    readonly rows: number;
    readonly cols: number;
    readonly sessionId: string;
    readonly nodeId: string;
    readonly endpointId: string;
  },
  openTimeoutMs: number,
): Promise<
  | { readonly resultType: 'opened'; readonly socket: RemoteFleetCustomTerminalWebSocket }
  | { readonly resultType: 'failed'; readonly result: RemoteFleetCustomTerminalOpenResult }
> {
  return new Promise((resolve) => {
    let settled = false;
    let pendingSocket: RemoteFleetCustomTerminalWebSocket | undefined;
    const timeout = setTimeout(() => {
      pendingSocket?.close();
      settle({ resultType: 'failed', result: failed('unavailable', 'Remote Fleet custom terminal WebSocket did not open before the timeout.') });
    }, openTimeoutMs);
    const settle = (result: { readonly resultType: 'opened'; readonly socket: RemoteFleetCustomTerminalWebSocket } | { readonly resultType: 'failed'; readonly result: RemoteFleetCustomTerminalOpenResult }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };

    try {
      pendingSocket = webSocketFactory({
        url: input.url,
        protocols: [REMOTE_FLEET_CUSTOM_TERMINAL_PROTOCOL_VERSION],
        headers: {
          ...(input.authorizationHeader ? { Authorization: input.authorizationHeader } : {}),
          'X-Remote-Fleet-Terminal-Session-Id': input.sessionId,
          'X-Remote-Fleet-Node-Id': input.nodeId,
          'X-Remote-Fleet-Endpoint-Id': input.endpointId,
          'X-Remote-Fleet-Terminal-Rows': String(input.rows),
          'X-Remote-Fleet-Terminal-Cols': String(input.cols),
        },
      });
    } catch {
      settle({ resultType: 'failed', result: failed('network', 'Remote Fleet custom terminal WebSocket could not be created.') });
      return;
    }

    const socket = pendingSocket;
    socket.on('open', () => settle({ resultType: 'opened', socket }));
    socket.on('error', () => settle({ resultType: 'failed', result: failed('network', 'Remote Fleet custom terminal WebSocket failed before opening.') }));
    socket.on('close', () => settle({ resultType: 'failed', result: failed('network', 'Remote Fleet custom terminal WebSocket closed before opening.') }));
  });
}

class RemoteFleetCustomTerminalStreamHandle implements RemoteFleetTerminalProviderStreamHandle {
  private readonly dataListeners: Array<(chunk: Uint8Array) => void> = [];
  private readonly exitListeners: Array<(event: RemoteFleetTerminalExitEvent) => void> = [];
  private readonly errorListeners: Array<(error: Error) => void> = [];
  private closed = false;

  constructor(private readonly socket: RemoteFleetCustomTerminalWebSocket) {
    socket.on('message', (data, isBinary) => this.dispatchMessage(data, isBinary));
    socket.on('close', (code, reason) => this.dispatchExit({
      exitCode: code,
      ...(reason.length > 0 ? { signal: reason.toString('utf8') } : {}),
    }, false));
    socket.on('error', () => this.dispatchError(new Error('Remote Fleet custom terminal WebSocket error.')));
  }

  write(data: Uint8Array): void {
    if (this.closed) return;
    this.socket.send(data);
  }

  resize(size: RemoteFleetTerminalSize): void {
    if (this.closed) return;
    this.socket.send(JSON.stringify({ type: 'terminal.resize', rows: size.rows, cols: size.cols } satisfies RemoteFleetTerminalControlFrame));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.send(JSON.stringify({ type: 'terminal.close', reason: 'closed by host' } satisfies RemoteFleetTerminalControlFrame));
    this.socket.close();
  }

  onData(listener: (chunk: Uint8Array) => void): void {
    this.dataListeners.push(listener);
  }

  onExit(listener: (event: RemoteFleetTerminalExitEvent) => void): void {
    this.exitListeners.push(listener);
  }

  onError(listener: (error: Error) => void): void {
    this.errorListeners.push(listener);
  }

  private dispatchMessage(data: WebSocket.RawData, isBinary: boolean): void {
    if (this.closed) return;
    const bytes = rawDataToBytes(data);
    if (isBinary) {
      this.dataListeners.forEach((listener) => listener(bytes));
      return;
    }

    const frame = parseControlFrame(bytes);
    if (!frame) {
      this.dispatchError(new Error('Remote Fleet custom terminal control frame is invalid.'));
      return;
    }
    switch (frame.type) {
      case 'terminal.error':
        this.dispatchError(new Error(frame.message));
        return;
      case 'terminal.exit':
        this.dispatchExit({
          ...(frame.exitCode !== undefined ? { exitCode: frame.exitCode } : {}),
          ...(frame.signal ? { signal: frame.signal } : {}),
        }, true);
        return;
      case 'terminal.close':
        this.dispatchExit({}, true);
        return;
      case 'terminal.ping':
        if (!this.closed) this.socket.send(JSON.stringify({ type: 'terminal.pong', ...(frame.nonce ? { nonce: frame.nonce } : {}) } satisfies RemoteFleetTerminalControlFrame));
        return;
      case 'terminal.ready':
      case 'terminal.resize':
      case 'terminal.pong':
        return;
    }
  }

  private dispatchError(error: Error): void {
    if (this.closed) return;
    this.errorListeners.forEach((listener) => listener(error));
  }

  private dispatchExit(event: RemoteFleetTerminalExitEvent, closeSocket: boolean): void {
    if (this.closed) return;
    this.closed = true;
    this.exitListeners.forEach((listener) => listener(event));
    if (closeSocket) this.socket.close();
  }
}

function createWsWebSocket(input: RemoteFleetCustomTerminalWebSocketFactoryInput): RemoteFleetCustomTerminalWebSocket {
  return new WebSocket(input.url, [...input.protocols], { headers: input.headers });
}

function parseControlFrame(bytes: Uint8Array): RemoteFleetTerminalControlFrame | null {
  try {
    const payload = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
    return isTerminalControlFrame(payload) ? payload : null;
  } catch {
    return null;
  }
}

function isTerminalControlFrame(value: unknown): value is RemoteFleetTerminalControlFrame {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const frame = value as Record<string, unknown>;
  switch (frame.type) {
    case 'terminal.resize':
      return Number.isInteger(frame.rows) && Number.isInteger(frame.cols);
    case 'terminal.close':
      return frame.reason === undefined || typeof frame.reason === 'string';
    case 'terminal.error':
      return typeof frame.message === 'string';
    case 'terminal.exit':
      return (frame.exitCode === undefined || typeof frame.exitCode === 'number')
        && (frame.signal === undefined || typeof frame.signal === 'string');
    case 'terminal.ping':
    case 'terminal.pong':
      return frame.nonce === undefined || typeof frame.nonce === 'string';
    case 'terminal.ready':
      return true;
    default:
      return false;
  }
}

function rawDataToBytes(data: WebSocket.RawData): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return Buffer.concat(data).subarray();
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function failed(
  reason: RemoteFleetCustomTerminalFailureReason,
  message: string,
): Extract<RemoteFleetCustomTerminalOpenResult, { readonly resultType: 'failed' }> {
  return {
    resultType: 'failed',
    providerKind: REMOTE_FLEET_CUSTOM_TERMINAL_PROVIDER_KIND,
    reason,
    message,
  };
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}
