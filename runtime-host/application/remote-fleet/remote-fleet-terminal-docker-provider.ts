import { EventEmitter } from 'node:events';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import type { Socket } from 'node:net';
import type { RuntimeHttpResponse } from '../common/runtime-ports';
import { evaluateRemoteFleetSecretRefPolicy } from './remote-fleet-secret-policy';
import {
  REMOTE_FLEET_SECRET_RESOLVE_PURPOSE_TERMINAL_SESSION,
} from './remote-fleet-secret-host-rpc';
import type { RemoteFleetTerminalSize } from './remote-fleet-terminal-contracts';
import type {
  RemoteFleetTerminalExitEvent,
  RemoteFleetTerminalOpenRequest,
  RemoteFleetTerminalProvider,
  RemoteFleetTerminalProviderStreamHandle,
  RemoteFleetTerminalSecretResolver,
} from './remote-fleet-terminal-providers';
import {
  REMOTE_FLEET_DOCKER_BEARER_TOKEN_SECRET_REF_NAME,
  REMOTE_FLEET_DOCKER_PROVIDER_KIND,
  buildDockerApiUrl,
  dockerApiPathSegment,
  readRemoteFleetDockerTerminalProviderConfig,
  type RemoteFleetDockerTerminalConfig,
  type RemoteFleetDockerTerminalProviderConfig,
} from './remote-fleet-docker-target-config';

const DOCKER_API_REQUEST_TIMEOUT_MS = 15_000;

export type RemoteFleetDockerTerminalFailureReason =
  | 'unsupported-target'
  | 'invalid-config'
  | 'endpoint-protocol-mismatch'
  | 'missing-secret'
  | 'auth'
  | 'network'
  | 'remote-error'
  | 'unavailable';

export type RemoteFleetDockerTerminalOpenResult =
  | {
      readonly resultType: 'opened';
      readonly handle: RemoteFleetTerminalProviderStreamHandle;
      readonly execId: string;
      readonly containerRef: string;
    }
  | {
      readonly resultType: 'failed';
      readonly providerKind: typeof REMOTE_FLEET_DOCKER_PROVIDER_KIND;
      readonly reason: RemoteFleetDockerTerminalFailureReason;
      readonly message: string;
    };

export interface RemoteFleetTerminalDockerProviderDeps {
  readonly execClient?: RemoteFleetDockerExecClient;
  readonly secretResolver?: RemoteFleetTerminalSecretResolver;
}

export interface RemoteFleetDockerExecClient {
  request(input: RemoteFleetDockerApiRequest): Promise<RemoteFleetDockerApiResponse>;
  start(input: RemoteFleetDockerExecStartRequest): Promise<RemoteFleetDockerExecStreamOpenResult>;
}

export interface RemoteFleetDockerApiRequest {
  readonly endpointUrl: string;
  readonly path: string;
  readonly method: string;
  readonly bearerToken?: string;
  readonly body?: unknown;
  readonly query?: Readonly<Record<string, string>>;
}

export interface RemoteFleetDockerApiResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export interface RemoteFleetDockerExecStartRequest {
  readonly endpointUrl: string;
  readonly execId: string;
  readonly bearerToken?: string;
  readonly body: Readonly<Record<string, unknown>>;
}

export type RemoteFleetDockerExecStreamOpenResult =
  | { readonly resultType: 'opened'; readonly stream: RemoteFleetDockerExecStream }
  | { readonly resultType: 'failed'; readonly status?: number; readonly message: string };

export interface RemoteFleetDockerExecStream {
  write(data: Uint8Array): void;
  close(): void;
  on(event: 'data', listener: (chunk: Uint8Array) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (event: RemoteFleetTerminalExitEvent) => void): this;
  pause?(): void;
  resume?(): void;
}

export interface RemoteFleetDockerTerminalProvider extends RemoteFleetTerminalProvider {
  readonly providerKind: typeof REMOTE_FLEET_DOCKER_PROVIDER_KIND;
  open(input: RemoteFleetTerminalOpenRequest): Promise<RemoteFleetDockerTerminalOpenResult>;
}

type DockerBearerTokenResult =
  | { readonly resultType: 'not-configured' }
  | { readonly resultType: 'resolved'; readonly token: string }
  | { readonly resultType: 'failed'; readonly result: RemoteFleetDockerTerminalOpenResult };

type DockerRawStreamOpenResult =
  | { readonly resultType: 'opened'; readonly stream: RemoteFleetDockerExecStream }
  | { readonly resultType: 'failed'; readonly status?: number; readonly message: string };

export function createRemoteFleetTerminalDockerProvider(
  deps: RemoteFleetTerminalDockerProviderDeps = {},
): RemoteFleetDockerTerminalProvider {
  return {
    providerKind: REMOTE_FLEET_DOCKER_PROVIDER_KIND,
    open: (input) => openDockerTerminal(input, deps),
  };
}

async function openDockerTerminal(
  input: RemoteFleetTerminalOpenRequest,
  deps: RemoteFleetTerminalDockerProviderDeps,
): Promise<RemoteFleetDockerTerminalOpenResult> {
  const node = input.node;
  if (!node) {
    return failed('invalid-config', 'Docker terminal sessions require a Remote Fleet node configuration.');
  }
  if (node.targetKind !== 'container') {
    return failed('unsupported-target', 'Docker terminal provider only supports container nodes.');
  }
  if (!Number.isInteger(input.rows) || input.rows < 1) {
    return failed('invalid-config', 'Docker terminal rows must be a positive integer.');
  }
  if (!Number.isInteger(input.cols) || input.cols < 1) {
    return failed('invalid-config', 'Docker terminal cols must be a positive integer.');
  }

  const configResult = readRemoteFleetDockerTerminalProviderConfig({
    connectionPublicConfig: input.connection?.publicConfig,
    connectionEndpointUrl: input.connection?.endpointUrl,
    connectionSecretRefs: input.connection?.secretRefs,
    environmentPublicConfig: input.environment?.publicConfig,
    environmentSecretRefs: input.environment?.secretRefs,
    nodePublicConfig: node.publicConfig,
    nodeSecretRefs: node.secretRefs,
    nodeId: node.id,
  });
  if (configResult.resultType === 'invalid') {
    return failed(configResult.reason, configResult.message);
  }

  const bearerTokenResult = await readDockerBearerToken(
    configResult.config,
    input.secretResolver ?? deps.secretResolver,
    input.session.id,
  );
  if (bearerTokenResult.resultType === 'failed') return bearerTokenResult.result;

  const bearerToken = bearerTokenResult.resultType === 'resolved' ? bearerTokenResult.token : undefined;
  const execClient = deps.execClient ?? defaultDockerExecClient;
  return await openDockerExecSession({
    input,
    config: configResult.config,
    bearerToken,
    execClient,
  });
}

async function openDockerExecSession(input: {
  readonly input: RemoteFleetTerminalOpenRequest;
  readonly config: RemoteFleetDockerTerminalConfig;
  readonly bearerToken?: string;
  readonly execClient: RemoteFleetDockerExecClient;
}): Promise<RemoteFleetDockerTerminalOpenResult> {
  const createResponseResult = await requestDockerApi(input.execClient, {
    endpointUrl: input.config.endpointUrl,
    path: `/containers/${dockerApiPathSegment(input.config.containerRef)}/exec`,
    method: 'POST',
    bearerToken: input.bearerToken,
    body: buildExecCreateBody(input.config.terminalCommand),
  });
  if (createResponseResult.resultType === 'failed') return createResponseResult.result;

  const createResponse = createResponseResult.response;
  if (!isSuccessfulResponse(createResponse)) {
    return failed(
      failureReasonForDockerStatus(createResponse.status),
      `Docker Engine returned HTTP ${createResponse.status} while creating terminal exec.`,
    );
  }

  const execId = await readExecId(createResponse);
  if (!execId) {
    return failed('remote-error', 'Docker Engine exec create response did not include an exec id.');
  }

  const streamResult = await input.execClient.start({
    endpointUrl: input.config.endpointUrl,
    execId,
    bearerToken: input.bearerToken,
    body: { Detach: false, Tty: true },
  });
  if (streamResult.resultType === 'failed') {
    return failed(
      streamResult.status ? failureReasonForDockerStatus(streamResult.status) : 'network',
      streamResult.message,
    );
  }

  const handle = new RemoteFleetDockerTerminalStreamHandle({
    stream: streamResult.stream,
    execClient: input.execClient,
    endpointUrl: input.config.endpointUrl,
    execId,
    bearerToken: input.bearerToken,
  });
  await handle.resizeNow({ rows: input.input.rows, cols: input.input.cols });

  return {
    resultType: 'opened',
    handle,
    execId,
    containerRef: input.config.containerRef,
  };
}

class RemoteFleetDockerTerminalStreamHandle implements RemoteFleetTerminalProviderStreamHandle {
  private readonly dataListeners: Array<(chunk: Uint8Array) => void> = [];
  private readonly exitListeners: Array<(event: RemoteFleetTerminalExitEvent) => void> = [];
  private readonly errorListeners: Array<(error: Error) => void> = [];
  private closed = false;

  constructor(private readonly deps: {
    readonly stream: RemoteFleetDockerExecStream;
    readonly execClient: RemoteFleetDockerExecClient;
    readonly endpointUrl: string;
    readonly execId: string;
    readonly bearerToken?: string;
  }) {
    deps.stream.on('data', (chunk) => this.dispatchData(chunk));
    deps.stream.on('error', (error) => this.dispatchError(error));
    deps.stream.on('exit', (event) => this.dispatchExit(event));
  }

  write(data: Uint8Array): void {
    if (this.closed) return;
    this.deps.stream.write(data);
  }

  resize(size: RemoteFleetTerminalSize): void {
    void this.resizeNow(size).catch(() => {
      this.dispatchError(new Error('Docker Engine exec resize request failed.'));
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.deps.stream.close();
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

  pause(): void {
    this.deps.stream.pause?.();
  }

  resume(): void {
    this.deps.stream.resume?.();
  }

  async resizeNow(size: RemoteFleetTerminalSize): Promise<void> {
    if (this.closed) return;
    const result = await requestDockerApi(this.deps.execClient, {
      endpointUrl: this.deps.endpointUrl,
      path: `/exec/${dockerApiPathSegment(this.deps.execId)}/resize`,
      method: 'POST',
      bearerToken: this.deps.bearerToken,
      query: { h: String(size.rows), w: String(size.cols) },
    });
    if (result.resultType === 'failed') throw new Error(result.result.message);
    if (!isSuccessfulResponse(result.response)) {
      throw new Error(`Docker Engine returned HTTP ${result.response.status} while resizing terminal exec.`);
    }
  }

  private dispatchData(chunk: Uint8Array): void {
    if (this.closed) return;
    this.dataListeners.forEach((listener) => listener(chunk));
  }

  private dispatchError(error: Error): void {
    if (this.closed) return;
    this.errorListeners.forEach((listener) => listener(error));
  }

  private dispatchExit(event: RemoteFleetTerminalExitEvent): void {
    if (this.closed) return;
    this.closed = true;
    this.exitListeners.forEach((listener) => listener(event));
  }
}

async function readDockerBearerToken(
  config: RemoteFleetDockerTerminalProviderConfig,
  secretResolver: RemoteFleetTerminalSecretResolver | undefined,
  terminalSessionId: string,
): Promise<DockerBearerTokenResult> {
  if (!config.dockerBearerTokenSecretRef) {
    return { resultType: 'not-configured' };
  }

  const secretRefPolicy = evaluateRemoteFleetSecretRefPolicy(config.dockerBearerTokenSecretRef);
  if (secretRefPolicy.decision !== 'allowed') {
    return { resultType: 'failed', result: failed('auth', 'Docker bearer token secretRef is not allowed by Remote Fleet secret policy.') };
  }
  if (!secretResolver) {
    return { resultType: 'failed', result: failed('unavailable', 'Docker terminal secret resolver is unavailable.') };
  }

  let readResult: Awaited<ReturnType<RemoteFleetTerminalSecretResolver['resolveSecret']>>;
  try {
    readResult = await secretResolver.resolveSecret({
      secretRef: config.dockerBearerTokenSecretRef,
      purpose: REMOTE_FLEET_SECRET_RESOLVE_PURPOSE_TERMINAL_SESSION,
      commandExecutionId: terminalSessionId,
    });
  } catch {
    return { resultType: 'failed', result: failed('unavailable', 'Docker terminal secret resolver is unavailable.') };
  }

  switch (readResult.resultType) {
    case 'resolved': {
      const token = readResult.plaintextSecretValue.trim();
      return token
        ? { resultType: 'resolved', token }
        : { resultType: 'failed', result: failed('missing-secret', 'Docker bearer token secret resolved to an empty value.') };
    }
    case 'notFound':
      return { resultType: 'failed', result: failed('missing-secret', 'Docker bearer token secret is missing.') };
    case 'accessDenied':
      return { resultType: 'failed', result: failed('auth', 'Docker bearer token secret could not be read due to access policy.') };
    case 'invalidRequest':
      return { resultType: 'failed', result: failed('invalid-config', 'Docker bearer token secret resolve request was rejected.') };
    case 'unavailable':
      return { resultType: 'failed', result: failed('unavailable', 'Docker bearer token secret resolver is unavailable.') };
  }
}

function buildExecCreateBody(command: readonly string[]): Readonly<Record<string, unknown>> {
  return {
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
    Cmd: command,
  };
}

async function requestDockerApi(
  execClient: RemoteFleetDockerExecClient,
  input: RemoteFleetDockerApiRequest,
): Promise<{ readonly resultType: 'response'; readonly response: RemoteFleetDockerApiResponse } | { readonly resultType: 'failed'; readonly result: RemoteFleetDockerTerminalOpenResult }> {
  try {
    return { resultType: 'response', response: await execClient.request(input) };
  } catch (error) {
    return {
      resultType: 'failed',
      result: failed(
        failureReasonForRequestError(error),
        'Docker Engine HTTP request failed.',
      ),
    };
  }
}

const defaultDockerExecClient: RemoteFleetDockerExecClient = {
  async request(input) {
    const headers: Record<string, string> = {};
    if (input.body !== undefined) headers['content-type'] = 'application/json';
    if (input.bearerToken) headers.Authorization = `Bearer ${input.bearerToken}`;

    return await fetch(buildDockerApiUrl(input.endpointUrl, input.path, input.query), {
      method: input.method,
      headers,
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      signal: AbortSignal.timeout(DOCKER_API_REQUEST_TIMEOUT_MS),
    }) as RuntimeHttpResponse;
  },

  async start(input) {
    const result = await openDockerRawStream(input);
    if (result.resultType === 'failed') return result;
    return result;
  },
};

function openDockerRawStream(input: RemoteFleetDockerExecStartRequest): Promise<DockerRawStreamOpenResult> {
  return new Promise((resolve) => {
    const url = new URL(buildDockerApiUrl(input.endpointUrl, `/exec/${dockerApiPathSegment(input.execId)}/start`));
    const body = JSON.stringify(input.body);
    const headers: Record<string, string | number> = {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      connection: 'Upgrade',
      upgrade: 'tcp',
    };
    if (input.bearerToken) headers.Authorization = `Bearer ${input.bearerToken}`;

    const request = (url.protocol === 'https:' ? https : http).request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers,
      timeout: DOCKER_API_REQUEST_TIMEOUT_MS,
    });
    let settled = false;
    const settle = (result: DockerRawStreamOpenResult) => {
      if (settled) return;
      settled = true;
      request.destroy();
      resolve(result);
    };

    request.on('upgrade', (response, socket, head) => {
      if (settled) return;
      settled = true;
      const status = response.statusCode ?? 0;
      if (status !== 101) {
        socket.destroy();
        resolve({ resultType: 'failed', status, message: `Docker Engine returned HTTP ${status} while starting terminal exec.` });
        return;
      }
      resolve({ resultType: 'opened', stream: new SocketDockerExecStream(socket, head) });
    });
    request.on('response', (response) => {
      const status = response.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        response.resume();
        settle({ resultType: 'failed', status, message: `Docker Engine returned HTTP ${status} while starting terminal exec.` });
        return;
      }
      if (settled) return;
      settled = true;
      resolve({ resultType: 'opened', stream: new IncomingMessageDockerExecStream(response) });
    });
    request.on('timeout', () => {
      settle({ resultType: 'failed', message: 'Docker Engine exec start request timed out.' });
    });
    request.on('error', () => {
      settle({ resultType: 'failed', message: 'Docker Engine exec start request failed.' });
    });
    request.end(body);
  });
}

class SocketDockerExecStream extends EventEmitter implements RemoteFleetDockerExecStream {
  private closed = false;

  constructor(private readonly socket: Socket, head: Buffer) {
    super();
    socket.on('data', (chunk) => this.emit('data', chunkToBytes(chunk)));
    socket.on('error', () => this.emit('error', new Error('Docker Engine exec stream failed.')));
    socket.on('close', () => this.dispatchExit({}));
    if (head.length > 0) queueMicrotask(() => this.emit('data', head));
  }

  write(data: Uint8Array): void {
    if (this.closed) return;
    this.socket.write(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.end();
  }

  pause(): void {
    this.socket.pause();
  }

  resume(): void {
    this.socket.resume();
  }

  private dispatchExit(event: RemoteFleetTerminalExitEvent): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('exit', event);
  }
}

class IncomingMessageDockerExecStream extends EventEmitter implements RemoteFleetDockerExecStream {
  private closed = false;

  constructor(private readonly response: IncomingMessage) {
    super();
    response.on('data', (chunk) => this.emit('data', chunkToBytes(chunk)));
    response.on('error', () => this.emit('error', new Error('Docker Engine exec stream failed.')));
    response.on('end', () => this.dispatchExit({}));
    response.on('close', () => this.dispatchExit({}));
  }

  write(data: Uint8Array): void {
    if (this.closed) return;
    if (!this.response.socket.write(data)) {
      this.response.pause();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.response.destroy();
  }

  pause(): void {
    this.response.pause();
  }

  resume(): void {
    this.response.resume();
  }

  private dispatchExit(event: RemoteFleetTerminalExitEvent): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('exit', event);
  }
}

async function readExecId(response: RemoteFleetDockerApiResponse): Promise<string | undefined> {
  try {
    const body = await response.json();
    if (!isRecord(body)) return undefined;
    const id = typeof body.Id === 'string' ? body.Id.trim() : '';
    return id || undefined;
  } catch {
    return undefined;
  }
}

function isSuccessfulResponse(response: RemoteFleetDockerApiResponse): boolean {
  return response.ok && response.status >= 200 && response.status < 300;
}

function failureReasonForDockerStatus(status: number): RemoteFleetDockerTerminalFailureReason {
  return status === 401 || status === 403 ? 'auth' : 'remote-error';
}

function failureReasonForRequestError(error: unknown): RemoteFleetDockerTerminalFailureReason {
  return error instanceof Error && error.name === 'TimeoutError' ? 'unavailable' : 'network';
}

function failed(
  reason: RemoteFleetDockerTerminalFailureReason,
  message: string,
): Extract<RemoteFleetDockerTerminalOpenResult, { readonly resultType: 'failed' }> {
  return {
    resultType: 'failed',
    providerKind: REMOTE_FLEET_DOCKER_PROVIDER_KIND,
    reason,
    message,
  };
}

function chunkToBytes(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk;
  if (Buffer.isBuffer(chunk)) return chunk;
  return new TextEncoder().encode(String(chunk));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
