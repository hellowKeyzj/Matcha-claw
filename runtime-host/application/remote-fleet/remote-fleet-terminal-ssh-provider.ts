import { evaluateRemoteFleetSecretRefPolicy } from './remote-fleet-secret-policy';
import {
  REMOTE_FLEET_SECRET_RESOLVE_PURPOSE_TERMINAL_SESSION,
} from './remote-fleet-secret-host-rpc';
import type { RemoteFleetTerminalSize } from './remote-fleet-terminal-contracts';
import type {
  RemoteFleetTerminalOpenRequest,
  RemoteFleetTerminalProvider,
  RemoteFleetTerminalProviderStreamHandle,
  RemoteFleetTerminalSecretResolver,
  RemoteFleetTerminalExitEvent,
} from './remote-fleet-terminal-providers';
import {
  readRemoteFleetSshAuthSecretRef,
  readRemoteFleetSshConnectionAuthSecretRef,
  readRemoteFleetSshConnectionConfig,
  readRemoteFleetSshTargetConfig,
  type RemoteFleetSshAuthSecretRefName,
  type RemoteFleetSshTargetConfig,
} from './remote-fleet-ssh-target-config';

export const REMOTE_FLEET_SSH_TERMINAL_PROVIDER_KIND = 'ssh' as const;
export const REMOTE_FLEET_VM_TERMINAL_PROVIDER_KIND = 'vm' as const;

const SSH_TERMINAL_DEFAULT_TERM = 'xterm-256color';
const SSH_TERMINAL_READY_TIMEOUT_MS = 15_000;
const OUTPUT_SUMMARY_LIMIT = 1_000;

type RemoteFleetSshTerminalProviderKind =
  | typeof REMOTE_FLEET_SSH_TERMINAL_PROVIDER_KIND
  | typeof REMOTE_FLEET_VM_TERMINAL_PROVIDER_KIND;

export type RemoteFleetSshTerminalFailureReason =
  | 'unsupported-target'
  | 'invalid-config'
  | 'missing-secret'
  | 'notFound'
  | 'accessDenied'
  | 'unavailable'
  | 'auth'
  | 'network'
  | 'remote-error';

export type RemoteFleetSshTerminalOpenResult =
  | {
      readonly resultType: 'opened';
      readonly handle: RemoteFleetTerminalProviderStreamHandle;
      readonly providerKind: RemoteFleetSshTerminalProviderKind;
      readonly summary: string;
    }
  | {
      readonly resultType: 'failed';
      readonly providerKind: RemoteFleetSshTerminalProviderKind;
      readonly reason: RemoteFleetSshTerminalFailureReason;
      readonly message: string;
    };

export interface RemoteFleetSshTerminalProviderDeps {
  readonly createSshClient?: RemoteFleetSshClientFactory;
}

export interface RemoteFleetSshTerminalProvider extends RemoteFleetTerminalProvider {
  readonly providerKind: RemoteFleetSshTerminalProviderKind;
  open(input: RemoteFleetTerminalOpenRequest): Promise<RemoteFleetSshTerminalOpenResult>;
}

export interface RemoteFleetTerminalProviderContext {
  readonly secretResolver?: RemoteFleetTerminalSecretResolver;
}

export interface RemoteFleetTerminalOpenInput {
  readonly terminalSessionId: string;
  readonly node: NonNullable<RemoteFleetTerminalOpenRequest['node']>;
  readonly rows?: number;
  readonly cols?: number;
  readonly term?: string;
  readonly onEvent: (event: RemoteFleetTerminalSshEvent) => void;
}

export type RemoteFleetTerminalSshEvent =
  | {
      readonly type: 'data';
      readonly providerKind: RemoteFleetSshTerminalProviderKind;
      readonly terminalSessionId: string;
      readonly data: string;
    }
  | {
      readonly type: 'error';
      readonly providerKind: RemoteFleetSshTerminalProviderKind;
      readonly terminalSessionId: string;
      readonly message: string;
    }
  | {
      readonly type: 'exit';
      readonly providerKind: RemoteFleetSshTerminalProviderKind;
      readonly terminalSessionId: string;
      readonly exitCode?: number;
      readonly signal?: string;
    };

export interface RemoteFleetTerminalSshSession {
  write(data: string | Uint8Array): void;
  resize(size: RemoteFleetTerminalSize): void;
  close(): void;
}

export type RemoteFleetTerminalOpenResult =
  | {
      readonly resultType: 'opened';
      readonly providerKind: RemoteFleetSshTerminalProviderKind;
      readonly terminalSessionId: string;
      readonly session: RemoteFleetTerminalSshSession;
      readonly summary: string;
    }
  | {
      readonly resultType: 'failed';
      readonly providerKind: RemoteFleetSshTerminalProviderKind;
      readonly terminalSessionId: string;
      readonly reason: RemoteFleetSshTerminalFailureReason;
      readonly message: string;
    };

export interface RemoteFleetTerminalSshProvider extends RemoteFleetSshTerminalProvider {
  openSession(
    input: RemoteFleetTerminalOpenInput,
    context?: RemoteFleetTerminalProviderContext,
  ): Promise<RemoteFleetTerminalOpenResult>;
}

export interface RemoteFleetSshClientFactory {
  (): RemoteFleetSshClient | Promise<RemoteFleetSshClient>;
}

export interface RemoteFleetSshClient {
  on(event: 'ready', listener: () => void): this;
  on(event: 'error', listener: (error: unknown) => void): this;
  on(event: 'close', listener: () => void): this;
  connect(config: RemoteFleetSshClientConnectConfig): void;
  shell(options: RemoteFleetSshShellOptions, callback: (error: unknown, stream?: RemoteFleetSshShellStream) => void): void;
  exec(command: string, callback: (error: unknown, stream?: RemoteFleetSshExecStream) => void): void;
  end(): void;
}

export interface RemoteFleetSshClientConnectConfig {
  readonly host: string;
  readonly port?: number;
  readonly username?: string;
  readonly password?: string;
  readonly privateKey?: string;
  readonly readyTimeout: number;
}

export interface RemoteFleetSshShellOptions {
  readonly term: string;
  readonly rows: number;
  readonly cols: number;
}

export interface RemoteFleetSshShellStream {
  readonly stderr?: RemoteFleetSshShellStderrStream;
  on(event: 'data', listener: (chunk: unknown) => void): this;
  on(event: 'error', listener: (error: unknown) => void): this;
  on(event: 'exit', listener: (code: unknown, signal?: unknown) => void): this;
  on(event: 'close', listener: () => void): this;
  write(data: Uint8Array): void;
  setWindow(rows: number, cols: number, height: number, width: number): void;
  end(): void;
  pause?(): void;
  resume?(): void;
}

export interface RemoteFleetSshExecStream {
  readonly stderr?: RemoteFleetSshShellStderrStream;
  on(event: 'data', listener: (chunk: unknown) => void): this;
  on(event: 'error', listener: (error: unknown) => void): this;
  on(event: 'exit', listener: (code: unknown, signal?: unknown) => void): this;
  on(event: 'close', listener: (code?: unknown, signal?: unknown) => void): this;
  end(): void;
  pause?(): void;
  resume?(): void;
}

export interface RemoteFleetSshShellStderrStream {
  on(event: 'data', listener: (chunk: unknown) => void): this;
}

type SshAuthMaterialReadResult =
  | { readonly resultType: 'private-key'; readonly privateKey: string; readonly secretRefName: RemoteFleetSshAuthSecretRefName }
  | { readonly resultType: 'password'; readonly password: string; readonly secretRefName: RemoteFleetSshAuthSecretRefName }
  | { readonly resultType: 'failed'; readonly result: RemoteFleetSshTerminalOpenResult };

interface NormalizedTerminalShellOptions {
  readonly rows: number;
  readonly cols: number;
  readonly term: string;
}

export const REMOTE_FLEET_SSH_TERMINAL_PROVIDER: RemoteFleetSshTerminalProvider = createRemoteFleetSshTerminalProvider();
export const REMOTE_FLEET_VM_TERMINAL_PROVIDER: RemoteFleetSshTerminalProvider = createRemoteFleetVmTerminalProvider();

export function createRemoteFleetSshTerminalProvider(
  deps: RemoteFleetSshTerminalProviderDeps = {},
): RemoteFleetSshTerminalProvider {
  return createSshLikeTerminalProvider(REMOTE_FLEET_SSH_TERMINAL_PROVIDER_KIND, deps);
}

export function createRemoteFleetVmTerminalProvider(
  deps: RemoteFleetSshTerminalProviderDeps = {},
): RemoteFleetSshTerminalProvider {
  return createSshLikeTerminalProvider(REMOTE_FLEET_VM_TERMINAL_PROVIDER_KIND, deps);
}

function createSshLikeTerminalProvider(
  providerKind: RemoteFleetSshTerminalProviderKind,
  deps: RemoteFleetSshTerminalProviderDeps,
): RemoteFleetSshTerminalProvider {
  return {
    providerKind,
    open: (input) => openSshTerminal(input, providerKind, deps),
  };
}

async function openSshTerminal(
  input: RemoteFleetTerminalOpenRequest,
  providerKind: RemoteFleetSshTerminalProviderKind,
  deps: RemoteFleetSshTerminalProviderDeps,
): Promise<RemoteFleetSshTerminalOpenResult> {
  const node = input.node;
  if (!node) {
    return failed(providerKind, 'invalid-config', 'Remote Fleet SSH terminal sessions require a Remote Fleet node configuration.');
  }
  if (node.targetKind !== 'ssh-host' && node.targetKind !== 'vm') {
    return failed(providerKind, 'unsupported-target', 'Remote Fleet SSH terminal provider only supports ssh-host and vm targets.');
  }

  const connection = input.connection;
  const configRead = connection
    ? readRemoteFleetSshConnectionConfig({ connection, targetKind: node.targetKind }, { operationLabel: 'terminal' })
    : readRemoteFleetSshTargetConfig(node, { operationLabel: 'terminal' });
  if (configRead.resultType === 'failed') {
    return failed(providerKind, configRead.reason, configRead.message);
  }

  const shellOptionsRead = readTerminalShellOptions(input);
  if (shellOptionsRead.resultType === 'failed') return failed(providerKind, 'invalid-config', shellOptionsRead.message);

  const authRead = await readSshAuthMaterial(input, providerKind, input.secretResolver);
  if (authRead.resultType === 'failed') return authRead.result;

  return openSshShell({
    input,
    providerKind,
    config: configRead.config,
    auth: authRead,
    shellOptions: shellOptionsRead.options,
    createSshClient: deps.createSshClient ?? createRemoteFleetSshClient,
  });
}

async function openSshShell(input: {
  readonly input: RemoteFleetTerminalOpenRequest;
  readonly providerKind: RemoteFleetSshTerminalProviderKind;
  readonly config: RemoteFleetSshTargetConfig;
  readonly auth: Exclude<SshAuthMaterialReadResult, { readonly resultType: 'failed' }>;
  readonly shellOptions: NormalizedTerminalShellOptions;
  readonly createSshClient: RemoteFleetSshClientFactory;
}): Promise<RemoteFleetSshTerminalOpenResult> {
  const secretValues = sshSecretValues(input.auth);
  let client: RemoteFleetSshClient;
  try {
    client = await input.createSshClient();
  } catch (error) {
    return failed(
      input.providerKind,
      'unavailable',
      buildSshFailureMessage('unavailable', error, secretValues),
    );
  }

  return await new Promise<RemoteFleetSshTerminalOpenResult>((resolve) => {
    let settled = false;
    let handle: RemoteFleetSshTerminalStreamHandle | undefined;

    client.on('ready', () => {
      client.shell(input.shellOptions, (error, stream) => {
        if (error || !stream) {
          const reason = classifySshFailure(error);
          if (!settled) {
            settled = true;
            resolve(failed(input.providerKind, reason, buildSshFailureMessage(reason, error, secretValues)));
          } else {
            handle?.dispatchError(new Error(safeErrorMessage(error, secretValues)));
          }
          client.end();
          return;
        }

        handle = new RemoteFleetSshTerminalStreamHandle({
          client,
          stream,
          secretValues,
        });
        handle.attach();

        if (!settled) {
          settled = true;
          resolve({
            resultType: 'opened',
            providerKind: input.providerKind,
            handle,
            summary: summarizeOpenSession(input.config),
          });
        }
      });
    });

    client.on('error', (error) => {
      const reason = classifySshFailure(error);
      if (!settled) {
        settled = true;
        resolve(failed(input.providerKind, reason, buildSshFailureMessage(reason, error, secretValues)));
        return;
      }
      handle?.dispatchError(new Error(safeErrorMessage(error, secretValues)));
    });

    client.on('close', () => {
      if (!settled) {
        settled = true;
        resolve(failed(input.providerKind, 'network', 'Remote Fleet SSH terminal connection closed before shell startup.'));
        return;
      }
      handle?.dispatchExit({});
    });

    try {
      client.connect(buildSshConnectConfig(input.config, input.auth));
    } catch (error) {
      const reason = classifySshFailure(error);
      if (!settled) {
        settled = true;
        resolve(failed(input.providerKind, reason, buildSshFailureMessage(reason, error, secretValues)));
      }
    }
  });
}

class RemoteFleetSshTerminalStreamHandle implements RemoteFleetTerminalProviderStreamHandle {
  private readonly dataListeners: Array<(chunk: Uint8Array) => void> = [];
  private readonly exitListeners: Array<(event: RemoteFleetTerminalExitEvent) => void> = [];
  private readonly errorListeners: Array<(error: Error) => void> = [];
  private closed = false;
  private exitEmitted = false;
  readonly #client: RemoteFleetSshClient;
  readonly #stream: RemoteFleetSshShellStream;
  readonly #secretValues: readonly string[];

  constructor(deps: {
    readonly client: RemoteFleetSshClient;
    readonly stream: RemoteFleetSshShellStream;
    readonly secretValues: readonly string[];
  }) {
    this.#client = deps.client;
    this.#stream = deps.stream;
    this.#secretValues = deps.secretValues;
  }

  attach(): void {
    this.#stream.on('data', (chunk) => {
      this.dispatchData(chunkToBytes(chunk));
    });
    this.#stream.stderr?.on('data', (chunk) => {
      this.dispatchData(chunkToBytes(chunk));
    });
    this.#stream.on('error', (error) => {
      this.dispatchError(new Error(safeErrorMessage(error, this.#secretValues)));
    });
    this.#stream.on('exit', (code, signal) => {
      this.dispatchExit({
        ...(typeof code === 'number' ? { exitCode: code } : {}),
        ...(typeof signal === 'string' && signal.length > 0 ? { signal } : {}),
      });
    });
    this.#stream.on('close', () => {
      this.dispatchExit({});
      const wasClosed = this.closed;
      this.closed = true;
      if (!wasClosed) this.#client.end();
    });
  }

  write(data: Uint8Array): void {
    if (this.closed) return;
    this.#stream.write(data);
  }

  resize(size: RemoteFleetTerminalSize): void {
    if (this.closed) return;
    this.#stream.setWindow(size.rows, size.cols, 0, 0);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.#stream.end();
    this.#client.end();
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
    this.#stream.pause?.();
  }

  resume(): void {
    this.#stream.resume?.();
  }

  dispatchError(error: Error): void {
    this.errorListeners.forEach((listener) => listener(error));
  }

  dispatchExit(event: RemoteFleetTerminalExitEvent): void {
    if (this.exitEmitted) return;
    this.exitEmitted = true;
    this.exitListeners.forEach((listener) => listener(event));
  }

  private dispatchData(chunk: Uint8Array): void {
    this.dataListeners.forEach((listener) => listener(chunk));
  }
}

async function readSshAuthMaterial(
  input: RemoteFleetTerminalOpenRequest,
  providerKind: RemoteFleetSshTerminalProviderKind,
  secretResolver: RemoteFleetTerminalSecretResolver | undefined,
): Promise<SshAuthMaterialReadResult> {
  const node = input.node;
  if (!node) {
    return { resultType: 'failed', result: failed(providerKind, 'invalid-config', 'Remote Fleet SSH terminal sessions require a Remote Fleet node configuration.') };
  }

  const authRefRead = input.connection
    ? readRemoteFleetSshConnectionAuthSecretRef(input.connection, { operationLabel: 'terminal' })
    : readRemoteFleetSshAuthSecretRef(node, { operationLabel: 'terminal' });
  if (authRefRead.resultType === 'failed') {
    return { resultType: 'failed', result: failed(providerKind, authRefRead.reason, authRefRead.message) };
  }

  const secretRefPolicy = evaluateRemoteFleetSecretRefPolicy(authRefRead.auth.secretRef.ref);
  if (secretRefPolicy.decision !== 'allowed') {
    return {
      resultType: 'failed',
      result: failed(providerKind, 'accessDenied', `Remote Fleet SSH terminal secretRef ${authRefRead.auth.secretRefName} access was denied.`),
    };
  }

  if (!secretResolver) {
    return {
      resultType: 'failed',
      result: failed(providerKind, 'unavailable', 'Remote Fleet SSH terminal secret resolver is unavailable.'),
    };
  }

  let readResult: Awaited<ReturnType<RemoteFleetTerminalSecretResolver['resolveSecret']>>;
  try {
    readResult = await secretResolver.resolveSecret({
      secretRef: authRefRead.auth.secretRef.ref,
      purpose: REMOTE_FLEET_SECRET_RESOLVE_PURPOSE_TERMINAL_SESSION,
      commandExecutionId: input.session.id,
    });
  } catch {
    return {
      resultType: 'failed',
      result: failed(providerKind, 'unavailable', 'Remote Fleet SSH terminal secret resolver is unavailable.'),
    };
  }

  return sshSecretResolveResult(providerKind, authRefRead.auth.secretRefName, authRefRead.auth.authKind, readResult);
}

function sshSecretResolveResult(
  providerKind: RemoteFleetSshTerminalProviderKind,
  secretRefName: RemoteFleetSshAuthSecretRefName,
  authKind: 'private-key' | 'password',
  readResult: Awaited<ReturnType<RemoteFleetTerminalSecretResolver['resolveSecret']>>,
): SshAuthMaterialReadResult {
  switch (readResult.resultType) {
    case 'resolved':
      if (readResult.plaintextSecretValue.trim().length === 0) {
        return { resultType: 'failed', result: failed(providerKind, 'missing-secret', emptySecretMessage(secretRefName)) };
      }
      return authKind === 'private-key'
        ? { resultType: 'private-key', privateKey: readResult.plaintextSecretValue, secretRefName }
        : { resultType: 'password', password: readResult.plaintextSecretValue, secretRefName };
    case 'notFound':
      return { resultType: 'failed', result: failed(providerKind, 'notFound', `Remote Fleet SSH terminal secretRef ${secretRefName} was not found.`) };
    case 'accessDenied':
      return { resultType: 'failed', result: failed(providerKind, 'accessDenied', `Remote Fleet SSH terminal secretRef ${secretRefName} access was denied.`) };
    case 'unavailable':
      return { resultType: 'failed', result: failed(providerKind, 'unavailable', 'Remote Fleet SSH terminal secret resolver is unavailable.') };
    case 'invalidRequest':
      return { resultType: 'failed', result: failed(providerKind, 'unavailable', 'Remote Fleet SSH terminal secret resolver rejected the request.') };
  }
}

function readTerminalShellOptions(input: RemoteFleetTerminalOpenRequest):
  | { readonly resultType: 'valid'; readonly options: NormalizedTerminalShellOptions }
  | { readonly resultType: 'failed'; readonly message: string } {
  if (!Number.isInteger(input.rows) || input.rows < 1) {
    return { resultType: 'failed', message: 'Remote Fleet SSH terminal rows must be a positive integer.' };
  }
  if (!Number.isInteger(input.cols) || input.cols < 1) {
    return { resultType: 'failed', message: 'Remote Fleet SSH terminal cols must be a positive integer.' };
  }

  const term = readTerminalTerm(input);
  if (/\0/.test(term)) {
    return { resultType: 'failed', message: 'Remote Fleet SSH terminal term must not contain NUL characters.' };
  }

  return {
    resultType: 'valid',
    options: {
      rows: input.rows,
      cols: input.cols,
      term,
    },
  };
}

function readTerminalTerm(input: RemoteFleetTerminalOpenRequest): string {
  const record = input as RemoteFleetTerminalOpenRequest & { readonly term?: unknown };
  return typeof record.term === 'string' && record.term.trim().length > 0
    ? record.term.trim()
    : SSH_TERMINAL_DEFAULT_TERM;
}

function buildSshConnectConfig(
  config: RemoteFleetSshTargetConfig,
  auth: Exclude<SshAuthMaterialReadResult, { readonly resultType: 'failed' }>,
): RemoteFleetSshClientConnectConfig {
  return {
    host: config.host,
    ...(config.port === undefined ? {} : { port: config.port }),
    ...(config.username ? { username: config.username } : {}),
    readyTimeout: SSH_TERMINAL_READY_TIMEOUT_MS,
    ...(auth.resultType === 'private-key' ? { privateKey: auth.privateKey } : { password: auth.password }),
  };
}

function failed(
  providerKind: RemoteFleetSshTerminalProviderKind,
  reason: RemoteFleetSshTerminalFailureReason,
  message: string,
): Extract<RemoteFleetSshTerminalOpenResult, { readonly resultType: 'failed' }> {
  return {
    resultType: 'failed',
    providerKind,
    reason,
    message,
  };
}

function summarizeOpenSession(config: RemoteFleetSshTargetConfig): string {
  const destination = config.username ? `${config.username}@${config.host}` : config.host;
  return config.port === undefined
    ? `Remote Fleet SSH terminal opened for ${destination}.`
    : `Remote Fleet SSH terminal opened for ${destination}:${config.port}.`;
}

function emptySecretMessage(secretRefName: RemoteFleetSshAuthSecretRefName): string {
  return secretRefName === 'sshPrivateKey'
    ? 'Remote Fleet SSH terminal private key secret is empty.'
    : 'Remote Fleet SSH terminal password secret is empty.';
}

function sshSecretValues(auth: Exclude<SshAuthMaterialReadResult, { readonly resultType: 'failed' }>): readonly string[] {
  return auth.resultType === 'private-key' ? [auth.privateKey] : [auth.password];
}

function classifySshFailure(error: unknown): Exclude<RemoteFleetSshTerminalFailureReason, 'unsupported-target' | 'invalid-config' | 'missing-secret' | 'notFound' | 'accessDenied'> {
  const errorRecord = isRecord(error) ? error : {};
  const code = typeof errorRecord.code === 'string' ? errorRecord.code : undefined;
  const text = errorText(error).toLowerCase();

  if (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') return 'unavailable';
  if (code === 'ENOTFOUND'
    || code === 'ECONNREFUSED'
    || code === 'ECONNRESET'
    || code === 'EHOSTUNREACH'
    || code === 'ENETUNREACH'
    || code === 'ETIMEDOUT'
    || text.includes('timed out')
    || text.includes('timeout')
    || text.includes('connection refused')
    || text.includes('could not resolve hostname')) {
    return 'network';
  }
  if (text.includes('permission denied')
    || text.includes('authentication failed')
    || text.includes('all configured authentication methods failed')
    || text.includes('host key verification failed')) {
    return 'auth';
  }
  return 'remote-error';
}

function buildSshFailureMessage(
  reason: RemoteFleetSshTerminalFailureReason,
  error: unknown,
  secretValues: readonly string[],
): string {
  const base = failureBaseMessage(reason);
  const summary = summarizeOutput([errorText(error)], secretValues);
  return summary ? `${base} ${summary}` : base;
}

function failureBaseMessage(reason: RemoteFleetSshTerminalFailureReason): string {
  switch (reason) {
    case 'auth':
      return 'Remote Fleet SSH terminal authentication failed.';
    case 'network':
      return 'Remote Fleet SSH terminal network connection failed.';
    case 'unavailable':
      return 'Remote Fleet ssh2 terminal transport is unavailable.';
    case 'remote-error':
      return 'Remote Fleet SSH terminal shell failed.';
    case 'invalid-config':
    case 'missing-secret':
    case 'unsupported-target':
    case 'notFound':
    case 'accessDenied':
      return 'Remote Fleet SSH terminal failed.';
  }
}

function safeErrorMessage(error: unknown, secretValues: readonly string[]): string {
  return summarizeOutput([errorText(error)], secretValues) ?? 'Remote Fleet SSH terminal error.';
}

function summarizeOutput(values: readonly string[], secretValues: readonly string[]): string | undefined {
  const raw = values.map((value) => value.trim()).filter(Boolean).join('\n').trim();
  if (!raw) return undefined;
  const redacted = redactSecrets(raw, secretValues).replace(/\s+/g, ' ').trim();
  if (!redacted) return undefined;
  return redacted.length <= OUTPUT_SUMMARY_LIMIT ? redacted : `${redacted.slice(0, OUTPUT_SUMMARY_LIMIT)}...`;
}

function redactSecrets(value: string, secretValues: readonly string[]): string {
  let redacted = value;
  for (const secretValue of secretValues) {
    for (const token of secretRedactionCandidates(secretValue)) {
      redacted = redacted.split(token).join('[redacted]');
    }
  }
  return redacted
    .replace(/(MATCHACLAW_[A-Z_]*(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY)[A-Z_]*=)([^\s'";]+)/g, '$1[redacted]')
    .replace(/(Authorization:\s*(?:Bearer|Basic)\s+)[^\s]+/gi, '$1[redacted]');
}

function secretRedactionCandidates(value: string): readonly string[] {
  const trimmed = value.trim();
  if (trimmed.length === 0) return [];
  const candidates = new Set<string>([value, trimmed]);
  for (const line of value.split(/\r?\n/g)) {
    const candidate = line.trim();
    if (candidate.length >= 8) candidates.add(candidate);
  }
  return Array.from(candidates).filter((candidate) => candidate.length > 0);
}

function errorText(error: unknown): string {
  if (!isRecord(error)) return error instanceof Error ? error.message : String(error);
  const message = error instanceof Error ? error.message : '';
  const description = typeof error.description === 'string' ? error.description : '';
  const level = typeof error.level === 'string' ? error.level : '';
  return [description, message, level].filter(Boolean).join('\n');
}

function chunkToBytes(chunk: unknown): Uint8Array {
  if (typeof chunk === 'string') return new TextEncoder().encode(chunk);
  if (chunk instanceof Uint8Array) return chunk;
  if (Buffer.isBuffer(chunk)) return chunk;
  return new TextEncoder().encode(String(chunk));
}

export async function createRemoteFleetSshClient(): Promise<RemoteFleetSshClient> {
  const ssh2Specifier = 'ssh2';
  const ssh2Module = await import(/* @vite-ignore */ ssh2Specifier) as { readonly Client?: new () => RemoteFleetSshClient };
  const Client = ssh2Module.Client;
  if (!Client) {
    throw new Error('ssh2 Client export is unavailable.');
  }
  return new Client();
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
