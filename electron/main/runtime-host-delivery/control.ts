import { randomUUID } from 'node:crypto';

export const RUNTIME_HOST_CONTROL_VERSION = 1;
export const MAX_RUNTIME_HOST_CONTROL_FRAME_BYTES = 1024 * 1024;

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_REQUEST_ID_BYTES = 128;
const MAX_SESSION_TRACE_ID_BYTES = 256;
const DEFAULT_MAX_PENDING_COMMANDS = 64;

type RuntimeHostJsonPrimitive = null | boolean | number | string;

export interface RuntimeHostJsonObject {
  readonly [key: string]: RuntimeHostJsonValue;
}

type RuntimeHostJsonArray = ReadonlyArray<RuntimeHostJsonValue>;

export type RuntimeHostJsonValue =
  | RuntimeHostJsonPrimitive
  | RuntimeHostJsonArray
  | RuntimeHostJsonObject;

type RuntimeHostPeerLifecycle =
  | 'unavailable'
  | 'idle'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'waitingToRestart'
  | 'failed'
  | 'shutDown';

export type RuntimeHostControlCommand =
  | { readonly name: 'host.health' }
  | { readonly name: 'host.runtime.snapshot' }
  | { readonly name: 'host.capabilities.list' }
  | {
      readonly name: 'host.capabilities.describe';
      readonly input: {
        readonly id: string;
        readonly scope: RuntimeHostJsonObject;
      };
    }
  | {
      readonly name: 'team.runtime.execute';
      readonly input: {
        readonly id: string;
        readonly operationId: string;
        readonly scope: RuntimeHostJsonObject;
        readonly target: RuntimeHostJsonValue;
        readonly input: RuntimeHostJsonObject;
        readonly traceId?: string;
      };
    }
  | { readonly name: 'matcha.lifecycle.status' }
  | { readonly name: 'matcha.lifecycle.start' }
  | { readonly name: 'matcha.lifecycle.stop' }
  | { readonly name: 'matcha.lifecycle.restart' }
  | { readonly name: 'openclaw.lifecycle.status' }
  | { readonly name: 'openclaw.environment.status' }
  | { readonly name: 'openclaw.runtime.paths' }
  | { readonly name: 'openclaw.cli.command' }
  | { readonly name: 'openclaw.tool-permission.get' }
  | {
      readonly name: 'openclaw.tool-permission.set';
      readonly input: { readonly mode: 'default' | 'fullAccess' };
    }
  | { readonly name: 'host.toolchain.status' }
  | { readonly name: 'host.toolchain.prepare' }
  | { readonly name: 'openclaw.subagent-templates.list' }
  | { readonly name: 'openclaw.subagent-templates.get'; readonly input: { readonly id: string } }
  | { readonly name: 'openclaw.lifecycle.start' }
  | { readonly name: 'openclaw.lifecycle.stop' }
  | { readonly name: 'openclaw.lifecycle.restart' }
  | { readonly name: 'openclaw.logs'; readonly input: { readonly cursor?: number } }
  | { readonly name: 'openclaw.control.ready' }
  | { readonly name: 'openclaw.gateway.health' }
  | { readonly name: 'openclaw.gateway.status' }
  | { readonly name: 'openclaw.control-ui.url' }
  | {
      readonly name: 'openclaw.browser.request';
      readonly input: {
        readonly method: string;
        readonly path: string;
        readonly query?: RuntimeHostJsonObject;
        readonly body?: RuntimeHostJsonValue;
        readonly timeoutMs?: number;
        readonly target?: 'host' | 'node';
        readonly node?: string;
      };
    }
  | {
      readonly name: 'openclaw.mcp-app.request';
      readonly input: {
        readonly operationId: string;
        readonly sessionKey: string;
        readonly viewId: string;
        readonly standalone?: boolean;
      };
    }
  | { readonly name: 'openclaw.sessions.patch-model'; readonly input: RuntimeHostJsonObject }
  | { readonly name: 'openclaw.skills.execute'; readonly input: RuntimeHostJsonObject }
  | { readonly name: 'openclaw.plugins.execute'; readonly input: RuntimeHostJsonObject }
  | { readonly name: 'fleet.credentials.write'; readonly input: RuntimeHostJsonObject };

export type RuntimeHostCommandRejectionCode =
  | 'INVALID_INPUT'
  | 'CAPACITY_EXHAUSTED'
  | 'UNAVAILABLE'
  | 'FAILED';

export type RuntimeHostControlOutcome =
  | {
      readonly kind: 'succeeded';
      readonly result: RuntimeHostJsonValue;
    }
  | {
      readonly kind: 'rejected';
      readonly error: {
        readonly code: RuntimeHostCommandRejectionCode;
        readonly message: string;
      };
    }
  | {
      readonly kind: 'unknown';
      readonly result: RuntimeHostJsonValue;
    }
  | { readonly kind: 'timed-out' };

export type RuntimeHostSafeEvent =
  | {
      readonly type: 'openclaw.lifecycle';
      readonly sequence: number | null;
      readonly hasRun: boolean;
      readonly hasMessage: boolean;
      readonly hasSessionActivity: boolean;
    }
  | { readonly type: 'openclaw.runtime' }
  | {
      readonly type: 'matcha.lifecycle';
      readonly lifecycle: RuntimeHostPeerLifecycle;
      readonly ready: boolean;
      readonly observedAtMs: number;
    }
  | {
      readonly type: 'openclaw.cron.execution';
      readonly jobId: string;
      readonly runId: string;
      readonly status: 'succeeded' | 'failed' | 'skipped' | 'cancelled' | 'outcome-unknown';
    }
  | {
      readonly type: 'matcha.session.activity';
      readonly routeKey: string;
      readonly sequence: number;
      readonly activity: MatchaSessionActivity;
    }
  | {
      readonly type: 'openclaw.session.activity';
      readonly routeKey: string;
      readonly sequence: number;
      readonly activity: OpenClawSessionActivity;
    }
  | {
      readonly type: 'openclaw.session.update';
      readonly routeKey: string;
      readonly kind: 'delta' | 'snapshot' | 'terminal';
      readonly sequence: number;
      readonly text?: string;
      readonly replace: boolean;
      readonly terminal?: 'completed' | 'aborted' | 'error';
      readonly errorKind?: 'refusal' | 'timeout' | 'rate_limit' | 'context_length' | 'unknown';
      readonly stopReason?: string;
    };

type OpenClawSessionActivity =
  | {
      readonly kind: 'message';
      readonly messageId: string;
      readonly lifecycle: 'started' | 'delta' | 'completed';
      readonly textDelta?: string;
    }
  | {
      readonly kind: 'tool';
      readonly toolId: string;
      readonly phase: 'started' | 'updated' | 'completed' | 'failed';
      readonly summary?: string;
    };

type MatchaSessionActivity =
  | {
      readonly kind: 'run';
      readonly phase: 'started' | 'waiting_for_approval' | 'completed' | 'cancelled' | 'failed' | 'interrupted';
    }
  | {
      readonly kind: 'message';
      readonly messageId: string;
      readonly lifecycle: 'started' | 'delta' | 'completed';
      readonly textDelta?: string;
    }
  | {
      readonly kind: 'tool';
      readonly toolCallId: string;
      readonly phase: 'started' | 'updated' | 'completed' | 'failed';
    }
  | {
      readonly kind: 'approval';
      readonly approvalId: string;
      readonly phase: 'requested';
      readonly optionIds: readonly string[];
    }
  | {
      readonly kind: 'approval';
      readonly approvalId: string;
      readonly phase: 'resolved';
    };

export type RuntimeHostControlDelivery = 'not-delivered' | 'unknown-delivery';

export type RuntimeHostControlErrorKind =
  | 'command-invalid'
  | 'frame-too-large'
  | 'pending-capacity-exceeded'
  | 'timeout-exceeded'
  | 'disconnected'
  | 'write-failed'
  | 'protocol-invalid';

export class RuntimeHostControlError extends Error {
  readonly retryable = false;

  constructor(
    readonly kind: RuntimeHostControlErrorKind,
    readonly delivery: RuntimeHostControlDelivery,
  ) {
    super(controlErrorMessage(kind));
    this.name = 'RuntimeHostControlError';
  }
}

export interface RuntimeHostControlInput {
  write(
    chunk: Uint8Array,
    callback: (error?: Error | null) => void,
  ): boolean;
}

export interface RuntimeHostControlOutput {
  on(
    event: 'data' | 'end' | 'close' | 'error',
    listener: (...arguments_: readonly unknown[]) => void,
  ): unknown;
  removeListener(
    event: 'data' | 'end' | 'close' | 'error',
    listener: (...arguments_: readonly unknown[]) => void,
  ): unknown;
}

export interface RuntimeHostControlClientOptions {
  readonly stdin: RuntimeHostControlInput;
  readonly stdout: RuntimeHostControlOutput;
  readonly defaultTimeoutMs?: number;
  readonly maxPendingCommands?: number;
}

export interface RuntimeHostControlCommandOptions {
  readonly timeoutMs?: number;
}

interface PendingCommand {
  readonly isMutating: boolean;
  hasAttemptedWrite: boolean;
  readonly resolve: (outcome: RuntimeHostControlOutcome) => void;
  readonly reject: (error: RuntimeHostControlError) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

type IncomingMessage =
  | { readonly kind: 'ready' }
  | {
      readonly kind: 'outcome';
      readonly id: string;
      readonly outcome: RuntimeHostControlOutcome;
    }
  | { readonly kind: 'event'; readonly event: RuntimeHostSafeEvent };

export class RuntimeHostControlClient {
  private readonly stdin: RuntimeHostControlInput;
  private readonly stdout: RuntimeHostControlOutput;
  private readonly defaultTimeoutMs: number;
  private readonly maxPendingCommands: number;
  private readonly pendingCommands = new Map<string, PendingCommand>();
  private readonly readyHandlers = new Set<() => void>();
  private readonly disconnectHandlers = new Set<(error: RuntimeHostControlError) => void>();
  private readonly safeEventHandlers = new Set<(event: RuntimeHostSafeEvent) => void>();
  private bufferedFrame = Buffer.alloc(0);
  private expectedFrameBytes: number | undefined;
  private disconnectError: RuntimeHostControlError | undefined;
  private isReady = false;
  private isClosed = false;

  constructor(options: RuntimeHostControlClientOptions) {
    this.stdin = options.stdin;
    this.stdout = options.stdout;
    this.defaultTimeoutMs = validateTimeoutMs(
      options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      'defaultTimeoutMs',
    );
    this.maxPendingCommands = validatePositiveInteger(
      options.maxPendingCommands ?? DEFAULT_MAX_PENDING_COMMANDS,
      'maxPendingCommands',
    );

    this.stdout.on('data', this.handleOutputData);
    this.stdout.on('end', this.handleOutputDisconnect);
    this.stdout.on('close', this.handleOutputDisconnect);
    this.stdout.on('error', this.handleOutputDisconnect);
  }

  command(
    command: RuntimeHostControlCommand,
    options: RuntimeHostControlCommandOptions = {},
  ): Promise<RuntimeHostControlOutcome> {
    if (this.isClosed) {
      return Promise.reject(new RuntimeHostControlError('disconnected', 'not-delivered'));
    }
    if (!isRuntimeHostControlCommand(command)) {
      return Promise.reject(new RuntimeHostControlError('command-invalid', 'not-delivered'));
    }
    if (this.pendingCommands.size >= this.maxPendingCommands) {
      return Promise.reject(new RuntimeHostControlError('pending-capacity-exceeded', 'not-delivered'));
    }

    const timeoutMs = validateTimeoutMs(
      options.timeoutMs ?? this.defaultTimeoutMs,
      'timeoutMs',
    );
    const id = randomUUID();
    let frame: Buffer;
    try {
      frame = encodeFrame({
        version: RUNTIME_HOST_CONTROL_VERSION,
        type: 'command',
        id,
        timeoutMs,
        command,
      });
    } catch {
      return Promise.reject(new RuntimeHostControlError('frame-too-large', 'not-delivered'));
    }

    return new Promise<RuntimeHostControlOutcome>((resolve, reject) => {
      const pending: PendingCommand = {
        isMutating: isMutatingCommand(command),
        hasAttemptedWrite: false,
        resolve,
        reject,
        timeout: setTimeout(() => this.rejectPending(id, 'timeout-exceeded'), timeoutMs),
      };
      this.pendingCommands.set(id, pending);

      try {
        pending.hasAttemptedWrite = true;
        this.stdin.write(frame, (error) => {
          if (error) this.rejectPending(id, 'write-failed');
        });
      } catch {
        this.rejectPending(id, 'write-failed');
      }
    });
  }

  onReady(handler: () => void): () => void {
    this.readyHandlers.add(handler);
    if (this.isReady) handler();
    return () => this.readyHandlers.delete(handler);
  }

  onDisconnect(handler: (error: RuntimeHostControlError) => void): () => void {
    this.disconnectHandlers.add(handler);
    if (this.disconnectError) handler(this.disconnectError);
    return () => this.disconnectHandlers.delete(handler);
  }

  onSafeEvent(handler: (event: RuntimeHostSafeEvent) => void): () => void {
    this.safeEventHandlers.add(handler);
    return () => this.safeEventHandlers.delete(handler);
  }

  close(): void {
    this.disconnect('disconnected');
  }

  private readonly handleOutputData = (chunk: unknown): void => {
    if (this.isClosed) return;
    if (!(Buffer.isBuffer(chunk) || chunk instanceof Uint8Array)) {
      this.disconnect('protocol-invalid');
      return;
    }

    const input = Buffer.from(chunk);
    let offset = 0;
    while (offset < input.length && !this.isClosed) {
      if (this.expectedFrameBytes === undefined) {
        offset = this.appendFrameBytes(input, offset, 4);
        if (this.bufferedFrame.length < 4) return;

        const bodyBytes = this.bufferedFrame.readUInt32BE(0);
        if (bodyBytes === 0 || bodyBytes > MAX_RUNTIME_HOST_CONTROL_FRAME_BYTES) {
          this.disconnect('protocol-invalid');
          return;
        }
        this.expectedFrameBytes = 4 + bodyBytes;
      }

      offset = this.appendFrameBytes(input, offset, this.expectedFrameBytes);
      if (this.bufferedFrame.length < this.expectedFrameBytes) return;

      const body = this.bufferedFrame.subarray(4);
      this.bufferedFrame = Buffer.alloc(0);
      this.expectedFrameBytes = undefined;
      const message = decodeIncomingMessage(body);
      if (!message) {
        this.disconnect('protocol-invalid');
        return;
      }
      this.handleIncomingMessage(message);
    }
  };

  private readonly handleOutputDisconnect = (): void => {
    this.disconnect('disconnected');
  };

  private appendFrameBytes(input: Buffer, offset: number, totalFrameBytes: number): number {
    const missingBytes = totalFrameBytes - this.bufferedFrame.length;
    const availableBytes = input.length - offset;
    const copiedBytes = Math.min(missingBytes, availableBytes);
    if (copiedBytes > 0) {
      this.bufferedFrame = Buffer.concat([
        this.bufferedFrame,
        input.subarray(offset, offset + copiedBytes),
      ]);
    }
    return offset + copiedBytes;
  }

  private handleIncomingMessage(message: IncomingMessage): void {
    if (!this.isReady && message.kind !== 'ready') {
      this.disconnect('protocol-invalid');
      return;
    }

    switch (message.kind) {
      case 'ready':
        if (this.isReady) {
          this.disconnect('protocol-invalid');
          return;
        }
        this.isReady = true;
        for (const handler of this.readyHandlers) handler();
        return;
      case 'outcome': {
        const pending = this.pendingCommands.get(message.id);
        if (!pending) return;

        this.pendingCommands.delete(message.id);
        clearTimeout(pending.timeout);
        pending.resolve(message.outcome);
        return;
      }
      case 'event':
        for (const handler of this.safeEventHandlers) handler(message.event);
        return;
    }
  }

  private rejectPending(id: string, kind: RuntimeHostControlErrorKind): void {
    const pending = this.pendingCommands.get(id);
    if (!pending) return;

    this.pendingCommands.delete(id);
    clearTimeout(pending.timeout);
    pending.reject(new RuntimeHostControlError(
      kind,
      pending.isMutating && pending.hasAttemptedWrite
        ? 'unknown-delivery'
        : 'not-delivered',
    ));
  }

  private disconnect(kind: Extract<RuntimeHostControlErrorKind, 'disconnected' | 'protocol-invalid'>): void {
    if (this.isClosed) return;

    const error = new RuntimeHostControlError(kind, 'not-delivered');
    this.isClosed = true;
    this.disconnectError = error;
    this.bufferedFrame = Buffer.alloc(0);
    this.expectedFrameBytes = undefined;
    this.stdout.removeListener('data', this.handleOutputData);
    this.stdout.removeListener('end', this.handleOutputDisconnect);
    this.stdout.removeListener('close', this.handleOutputDisconnect);
    this.stdout.removeListener('error', this.handleOutputDisconnect);

    for (const handler of this.disconnectHandlers) handler(error);
    for (const id of this.pendingCommands.keys()) this.rejectPending(id, kind);
  }
}

function encodeFrame(message: RuntimeHostJsonObject): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (body.length > MAX_RUNTIME_HOST_CONTROL_FRAME_BYTES) {
    throw new Error('frame exceeds the maximum size');
  }

  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

function decodeIncomingMessage(body: Buffer): IncomingMessage | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    return undefined;
  }

  if (!isRecord(raw) || raw.version !== RUNTIME_HOST_CONTROL_VERSION) return undefined;
  if (raw.type === 'ready') {
    return hasExactKeys(raw, ['version', 'type']) ? { kind: 'ready' } : undefined;
  }
  if (raw.type === 'outcome') return decodeOutcomeMessage(raw);
  if (raw.type === 'event') return decodeEvent(raw);
  return undefined;
}

function decodeOutcomeMessage(raw: Record<string, unknown>): IncomingMessage | undefined {
  if (!hasExactKeys(raw, ['version', 'type', 'id', 'outcome'])
    || !isRequestId(raw.id)
    || !isRecord(raw.outcome)) {
    return undefined;
  }
  const outcome = decodeOutcome(raw.outcome);
  return outcome ? { kind: 'outcome', id: raw.id, outcome } : undefined;
}

function decodeOutcome(raw: Record<string, unknown>): RuntimeHostControlOutcome | undefined {
  if (raw.kind === 'succeeded') {
    if (!hasExactKeys(raw, ['kind', 'result']) || !isJsonValue(raw.result)) return undefined;
    return { kind: 'succeeded', result: raw.result };
  }
  if (raw.kind === 'rejected') {
    if (!hasExactKeys(raw, ['kind', 'error']) || !isRejection(raw.error)) return undefined;
    return { kind: 'rejected', error: raw.error };
  }
  if (raw.kind === 'unknown') {
    if (!hasExactKeys(raw, ['kind', 'result']) || !isJsonValue(raw.result)) return undefined;
    return { kind: 'unknown', result: raw.result };
  }
  if (raw.kind === 'timed-out') {
    return hasExactKeys(raw, ['kind']) ? { kind: 'timed-out' } : undefined;
  }
  return undefined;
}

function decodeEvent(raw: Record<string, unknown>): IncomingMessage | undefined {
  if (!hasExactKeys(raw, ['version', 'type', 'event']) || !isRuntimeHostSafeEvent(raw.event)) {
    return undefined;
  }
  return { kind: 'event', event: normalizeSafeEvent(raw.event) };
}

function normalizeSafeEvent(event: RuntimeHostSafeEvent): RuntimeHostSafeEvent {
  if (event.type !== 'openclaw.session.update') return event;
  return { ...event, replace: event.replace ?? false };
}

function isRuntimeHostControlCommand(value: RuntimeHostControlCommand): boolean {
  if (!isRecord(value) || typeof value.name !== 'string') return false;
  switch (value.name) {
    case 'host.health':
    case 'host.runtime.snapshot':
    case 'host.capabilities.list':
      return hasExactKeys(value, ['name']);
    case 'host.capabilities.describe':
      return isHostCapabilitiesDescribeCommand(value);
    case 'team.runtime.execute':
      return isTeamRuntimeExecuteCommand(value);
    case 'matcha.lifecycle.status':
    case 'matcha.lifecycle.start':
    case 'matcha.lifecycle.stop':
    case 'matcha.lifecycle.restart':
    case 'openclaw.lifecycle.status':
    case 'openclaw.environment.status':
    case 'openclaw.runtime.paths':
    case 'openclaw.cli.command':
    case 'openclaw.tool-permission.get':
    case 'openclaw.subagent-templates.list':
    case 'openclaw.lifecycle.start':
    case 'openclaw.lifecycle.stop':
    case 'openclaw.lifecycle.restart':
    case 'openclaw.gateway.health':
    case 'openclaw.gateway.status':
    case 'openclaw.control-ui.url':
      return hasExactKeys(value, ['name']);
    case 'openclaw.browser.request':
      return isOpenClawBrowserRequestCommand(value);
    case 'openclaw.mcp-app.request':
      return isOpenClawMcpAppRequestCommand(value);
    case 'openclaw.logs':
      return isOpenClawLogsCommand(value);
    case 'openclaw.control.ready':
      return isOpenClawControlReadyCommand(value);
    case 'openclaw.tool-permission.set':
      return isOpenClawToolPermissionSetCommand(value);
    case 'host.toolchain.status':
    case 'host.toolchain.prepare':
      return hasExactKeys(value, ['name']);
    case 'openclaw.subagent-templates.get':
      return isSubagentTemplateCommand(value);
    case 'openclaw.sessions.patch-model':
    case 'openclaw.skills.execute':
    case 'openclaw.plugins.execute':
      return hasExactKeys(value, ['name', 'input']) && isJsonObject(value.input);
    case 'fleet.credentials.write':
      return isFleetCredentialWriteCommand(value);
    default:
      return false;
  }
}

function isHostCapabilitiesDescribeCommand(value: Record<string, unknown>): boolean {
  if (!hasExactKeys(value, ['name', 'input'])
    || value.name !== 'host.capabilities.describe'
    || !isRecord(value.input)
    || !hasExactKeys(value.input, ['id', 'scope'])) {
    return false;
  }
  return isCapabilityIdentity(value.input.id) && isJsonObject(value.input.scope);
}

function isCapabilityIdentity(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && !Array.from(value).some((character) => /\p{Cc}/u.test(character));
}

function isTeamRuntimeExecuteCommand(value: Record<string, unknown>): boolean {
  if (!hasExactKeys(value, ['name', 'input'])
    || value.name !== 'team.runtime.execute'
    || !isRecord(value.input)
    || !hasOnlyKeys(value.input, ['id', 'operationId', 'scope', 'target', 'input', 'traceId'])
    || !['id', 'operationId', 'scope', 'target', 'input'].every((key) => hasOwn(value.input as Record<string, unknown>, key))) {
    return false;
  }
  return value.input.id === 'team.runtime'
    && isCapabilityIdentity(value.input.operationId)
    && isJsonObject(value.input.scope)
    && isJsonValue(value.input.target)
    && isJsonObject(value.input.input)
    && (value.input.traceId === undefined || isSessionTraceId(value.input.traceId));
}

function isFleetCredentialWriteCommand(value: Record<string, unknown>): boolean {
  if (!hasExactKeys(value, ['name', 'input']) || !isRecord(value.input) || !hasExactKeys(value.input, ['operationId', 'credentialId', 'credentialName', 'plaintextValue'])) return false;
  return typeof value.input.operationId === 'string' && value.input.operationId.length > 0 && value.input.operationId.length <= 128
    && typeof value.input.credentialId === 'string' && value.input.credentialId.length > 0 && value.input.credentialId.length <= 128
    && typeof value.input.credentialName === 'string' && ['sshPassword', 'sshPrivateKey', 'dockerBearerToken', 'kubeBearerToken'].includes(value.input.credentialName)
    && typeof value.input.plaintextValue === 'string' && value.input.plaintextValue.length > 0 && value.input.plaintextValue.length <= 256 * 1024;
}

function isSessionTraceId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_SESSION_TRACE_ID_BYTES
    && !Array.from(value).some((character) => /\p{Cc}/u.test(character));
}

function isOpenClawControlReadyCommand(value: Record<string, unknown>): boolean {
  return hasExactKeys(value, ['name']) && value.name === 'openclaw.control.ready';
}

function isOpenClawLogsCommand(value: Record<string, unknown>): boolean {
  if (!hasExactKeys(value, ['name', 'input']) || value.name !== 'openclaw.logs' || !isRecord(value.input)) {
    return false;
  }
  return hasExactKeys(value.input, [])
    || (hasExactKeys(value.input, ['cursor']) && isNonNegativeSafeInteger(value.input.cursor));
}

function isOpenClawBrowserRequestCommand(value: Record<string, unknown>): boolean {
  if (!hasExactKeys(value, ['name', 'input'])
    || value.name !== 'openclaw.browser.request'
    || !isRecord(value.input)
    || !hasOnlyKeys(value.input, ['method', 'path', 'query', 'body', 'timeoutMs', 'target', 'node'])
    || !hasOwn(value.input, 'method')
    || !hasOwn(value.input, 'path')) {
    return false;
  }
  return isBoundedCommandText(value.input.method)
    && isBoundedCommandText(value.input.path)
    && (value.input.query === undefined || isJsonObject(value.input.query))
    && (value.input.body === undefined || isJsonValue(value.input.body))
    && (value.input.timeoutMs === undefined || isPositiveSafeInteger(value.input.timeoutMs))
    && (value.input.target === undefined || value.input.target === 'host' || value.input.target === 'node')
    && (value.input.node === undefined || (value.input.target === 'node' && isBoundedCommandText(value.input.node)));
}

function isOpenClawMcpAppRequestCommand(value: Record<string, unknown>): boolean {
  if (!hasExactKeys(value, ['name', 'input'])
    || value.name !== 'openclaw.mcp-app.request'
    || !isRecord(value.input)
    || !hasOnlyKeys(value.input, ['operationId', 'sessionKey', 'viewId', 'standalone'])
    || !hasOwn(value.input, 'operationId')
    || !hasOwn(value.input, 'sessionKey')
    || !hasOwn(value.input, 'viewId')) {
    return false;
  }
  return isMcpAppOperationId(value.input.operationId)
    && isBoundedCommandText(value.input.sessionKey)
    && isBoundedCommandText(value.input.viewId)
    && (value.input.standalone === undefined || typeof value.input.standalone === 'boolean');
}

function isMcpAppOperationId(value: unknown): value is string {
  return isBoundedCommandText(value) && value.startsWith('mcp.app.');
}

function isBoundedCommandText(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && Buffer.byteLength(value, 'utf8') <= 4_096
    && !Array.from(value).some((character) => /\p{Cc}/u.test(character));
}

function isOpenClawToolPermissionSetCommand(value: Record<string, unknown>): boolean {
  return hasExactKeys(value, ['name', 'input'])
    && value.name === 'openclaw.tool-permission.set'
    && isRecord(value.input)
    && hasExactKeys(value.input, ['mode'])
    && (value.input.mode === 'default' || value.input.mode === 'fullAccess');
}

function isSubagentTemplateCommand(value: Record<string, unknown>): boolean {
  return hasExactKeys(value, ['name', 'input'])
    && value.name === 'openclaw.subagent-templates.get'
    && isRecord(value.input)
    && hasExactKeys(value.input, ['id'])
    && typeof value.input.id === 'string'
    && value.input.id.trim().length > 0
    && value.input.id.length <= 128;
}

function isMutatingCommand(command: RuntimeHostControlCommand): boolean {
  return command.name === 'matcha.lifecycle.start'
    || command.name === 'matcha.lifecycle.stop'
    || command.name === 'matcha.lifecycle.restart'
    || command.name === 'openclaw.lifecycle.start'
    || command.name === 'openclaw.lifecycle.stop'
    || command.name === 'openclaw.lifecycle.restart'
    || command.name === 'openclaw.tool-permission.set'
    || command.name === 'host.toolchain.prepare'
    || command.name === 'openclaw.browser.request'
    || command.name === 'openclaw.mcp-app.request'
    || command.name === 'openclaw.sessions.patch-model'
    || command.name === 'team.runtime.execute'
    || command.name === 'openclaw.skills.execute'
    || command.name === 'openclaw.plugins.execute'
    || command.name === 'fleet.credentials.write';
}

function isRuntimeHostSafeEvent(value: unknown): value is RuntimeHostSafeEvent {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  switch (value.type) {
    case 'openclaw.lifecycle':
      return hasExactKeys(value, ['type', 'sequence', 'hasRun', 'hasMessage', 'hasSessionActivity'])
        && (value.sequence === null || isNonNegativeSafeInteger(value.sequence))
        && typeof value.hasRun === 'boolean'
        && typeof value.hasMessage === 'boolean'
        && typeof value.hasSessionActivity === 'boolean';
    case 'openclaw.runtime':
      return hasExactKeys(value, ['type']);
    case 'matcha.lifecycle':
      return hasExactKeys(value, ['type', 'lifecycle', 'ready', 'observedAtMs'])
        && isRuntimeHostPeerLifecycle(value.lifecycle)
        && typeof value.ready === 'boolean'
        && isNonNegativeSafeInteger(value.observedAtMs);
    case 'openclaw.cron.execution':
      return hasExactKeys(value, ['type', 'jobId', 'runId', 'status'])
        && isCronExecutionId(value.jobId)
        && isCronExecutionId(value.runId)
        && isCronExecutionStatus(value.status);
    case 'matcha.session.activity':
      return isMatchaSessionActivity(value);
    case 'openclaw.session.activity':
      return isOpenClawSessionActivity(value);
    case 'openclaw.session.update':
      return isOpenClawSessionUpdate(value);
    default:
      return false;
  }
}

function isRuntimeHostPeerLifecycle(value: unknown): value is RuntimeHostPeerLifecycle {
  return value === 'unavailable'
    || value === 'idle'
    || value === 'starting'
    || value === 'running'
    || value === 'stopping'
    || value === 'waitingToRestart'
    || value === 'failed'
    || value === 'shutDown';
}

function isCronExecutionId(value: unknown): value is string {
  return typeof value === 'string'
    && /^[A-Za-z0-9._:-]+$/.test(value)
    && value.length <= 128;
}

function isCronExecutionStatus(
  value: unknown,
): value is 'succeeded' | 'failed' | 'skipped' | 'cancelled' | 'outcome-unknown' {
  return value === 'succeeded'
    || value === 'failed'
    || value === 'skipped'
    || value === 'cancelled'
    || value === 'outcome-unknown';
}

function isRendererRouteKey(value: unknown): value is string {
  return typeof value === 'string'
    && /^renderer-route:[A-Za-z0-9_-]+$/.test(value)
    && value.length <= 128;
}

function isOpenClawSessionActivity(value: Record<string, unknown>): value is RuntimeHostSafeEvent & { readonly type: 'openclaw.session.activity' } {
  if (!hasExactKeys(value, ['type', 'routeKey', 'sequence', 'activity'])
    || !isRendererRouteKey(value.routeKey)
    || !isNonNegativeSafeInteger(value.sequence)
    || !isRecord(value.activity)) {
    return false;
  }
  return isOpenClawActivity(value.activity);
}

function isOpenClawActivity(value: Record<string, unknown>): value is OpenClawSessionActivity {
  if (typeof value.kind !== 'string') return false;
  switch (value.kind) {
    case 'message':
      if (!hasExactKeys(value, ['kind', 'messageId', 'lifecycle', ...(hasOwn(value, 'textDelta') ? ['textDelta'] : [])])
        || !isOpaqueActivityId(value.messageId)
        || !isMessageLifecycle(value.lifecycle)) {
        return false;
      }
      if (value.lifecycle === 'delta' && !hasOwn(value, 'textDelta')) return false;
      if (value.lifecycle !== 'delta' && hasOwn(value, 'textDelta')) return false;
      return !hasOwn(value, 'textDelta') || isBoundedActivityText(value.textDelta);
    case 'tool':
      if (!hasExactKeys(value, ['kind', 'toolId', 'phase', ...(hasOwn(value, 'summary') ? ['summary'] : [])])
        || !isOpaqueActivityId(value.toolId)
        || !isToolActivityPhase(value.phase)) {
        return false;
      }
      return !hasOwn(value, 'summary') || isBoundedActivitySummary(value.summary);
    default:
      return false;
  }
}

function isBoundedActivitySummary(value: unknown): value is string {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= 256;
}

function isMatchaSessionActivity(value: Record<string, unknown>): value is RuntimeHostSafeEvent & { readonly type: 'matcha.session.activity' } {
  if (!hasExactKeys(value, ['type', 'routeKey', 'sequence', 'activity'])
    || !isRendererRouteKey(value.routeKey)
    || !isNonNegativeSafeInteger(value.sequence)
    || !isRecord(value.activity)) {
    return false;
  }
  return isMatchaActivity(value.activity);
}

function isMatchaActivity(value: Record<string, unknown>): value is MatchaSessionActivity {
  if (typeof value.kind !== 'string') return false;
  switch (value.kind) {
    case 'run':
      return hasExactKeys(value, ['kind', 'phase']) && isMatchaRunPhase(value.phase);
    case 'message':
      if (!hasExactKeys(value, ['kind', 'messageId', 'lifecycle', ...(hasOwn(value, 'textDelta') ? ['textDelta'] : [])])
        || !isOpaqueActivityId(value.messageId)
        || !isMessageLifecycle(value.lifecycle)) {
        return false;
      }
      if (value.lifecycle === 'delta' && !hasOwn(value, 'textDelta')) return false;
      if (value.lifecycle !== 'delta' && hasOwn(value, 'textDelta')) return false;
      return !hasOwn(value, 'textDelta') || isBoundedActivityText(value.textDelta);
    case 'tool':
      return hasExactKeys(value, ['kind', 'toolCallId', 'phase'])
        && isOpaqueActivityId(value.toolCallId)
        && isToolActivityPhase(value.phase);
    case 'approval':
      if (!hasExactKeys(value, ['kind', 'approvalId', 'phase', ...(hasOwn(value, 'optionIds') ? ['optionIds'] : [])])
        || !isOpaqueActivityId(value.approvalId)
        || !isApprovalPhase(value.phase)) {
        return false;
      }
      if (value.phase === 'resolved') return !hasOwn(value, 'optionIds');
      return hasOwn(value, 'optionIds') && isApprovalOptionIds(value.optionIds);
    default:
      return false;
  }
}

function isOpaqueActivityId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= 128;
}

function isBoundedActivityText(value: unknown): value is string {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= 16 * 1024;
}

function isMessageLifecycle(value: unknown): value is 'started' | 'delta' | 'completed' {
  return value === 'started' || value === 'delta' || value === 'completed';
}

function isToolActivityPhase(value: unknown): value is 'started' | 'updated' | 'completed' | 'failed' {
  return value === 'started' || value === 'updated' || value === 'completed' || value === 'failed';
}

function isApprovalPhase(value: unknown): value is 'requested' | 'resolved' {
  return value === 'requested' || value === 'resolved';
}

function isApprovalOptionIds(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length > 32) return false;
  const uniqueOptionIds = new Set<string>();
  for (const optionId of value) {
    if (!isOpaqueActivityId(optionId) || uniqueOptionIds.has(optionId)) return false;
    uniqueOptionIds.add(optionId);
  }
  return true;
}

function isMatchaRunPhase(value: unknown): boolean {
  return value === 'started'
    || value === 'waiting_for_approval'
    || value === 'completed'
    || value === 'cancelled'
    || value === 'failed'
    || value === 'interrupted';
}

const MAX_SESSION_UPDATE_TEXT_BYTES = 128 * 1024;
const MAX_SESSION_UPDATE_STOP_REASON_BYTES = 256;

function isOpenClawSessionUpdate(value: Record<string, unknown>): value is RuntimeHostSafeEvent & { readonly type: 'openclaw.session.update' } {
  const keys = Object.keys(value);
  const allowedKeys = ['type', 'routeKey', 'kind', 'sequence', 'text', 'replace', 'terminal', 'errorKind', 'stopReason'];
  if (!keys.every((key) => allowedKeys.includes(key))
    || !hasOwn(value, 'type')
    || !hasOwn(value, 'routeKey')
    || !hasOwn(value, 'kind')
    || !hasOwn(value, 'sequence')) {
    return false;
  }
  if (!isRendererRouteKey(value.routeKey)
    || !isOpenClawSessionUpdateKind(value.kind)
    || !isNonNegativeSafeInteger(value.sequence)) {
    return false;
  }
  if (hasOwn(value, 'text') && (typeof value.text !== 'string' || Buffer.byteLength(value.text, 'utf8') > MAX_SESSION_UPDATE_TEXT_BYTES)) {
    return false;
  }
  if (hasOwn(value, 'replace') && typeof value.replace !== 'boolean') return false;
  if (hasOwn(value, 'terminal') && !isOpenClawSessionTerminal(value.terminal)) return false;
  if (hasOwn(value, 'errorKind') && !isSafeSessionErrorKind(value.errorKind)) return false;
  if (hasOwn(value, 'stopReason') && (typeof value.stopReason !== 'string' || Buffer.byteLength(value.stopReason, 'utf8') > MAX_SESSION_UPDATE_STOP_REASON_BYTES)) return false;
  if (value.kind === 'terminal') return isOpenClawSessionTerminal(value.terminal);
  return !hasOwn(value, 'terminal');
}

function isOpenClawSessionUpdateKind(value: unknown): value is 'delta' | 'snapshot' | 'terminal' {
  return value === 'delta' || value === 'snapshot' || value === 'terminal';
}

function isOpenClawSessionTerminal(value: unknown): value is 'completed' | 'aborted' | 'error' {
  return value === 'completed' || value === 'aborted' || value === 'error';
}

function isSafeSessionErrorKind(value: unknown): value is 'refusal' | 'timeout' | 'rate_limit' | 'context_length' | 'unknown' {
  return value === 'refusal' || value === 'timeout' || value === 'rate_limit' || value === 'context_length' || value === 'unknown';
}

function isRejection(value: unknown): value is Extract<RuntimeHostControlOutcome, { readonly kind: 'rejected' }>['error'] {
  return isRecord(value)
    && hasExactKeys(value, ['code', 'message'])
    && isRejectionCode(value.code)
    && typeof value.message === 'string';
}

function isRejectionCode(value: unknown): value is RuntimeHostCommandRejectionCode {
  return value === 'INVALID_INPUT'
    || value === 'CAPACITY_EXHAUSTED'
    || value === 'UNAVAILABLE'
    || value === 'FAILED';
}

function isJsonObject(value: unknown): value is RuntimeHostJsonObject {
  return isRecord(value) && isJsonValue(value);
}

function isJsonValue(value: unknown, seen = new Set<object>()): value is RuntimeHostJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value)) return false;

  seen.add(value);
  if (Array.isArray(value)) return value.every((entry) => isJsonValue(entry, seen));
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    return false;
  }
  return Object.values(value).every((entry) => isJsonValue(entry, seen));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => hasOwn(value, key));
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isRequestId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= MAX_REQUEST_ID_BYTES;
}

function validateTimeoutMs(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
    throw new RangeError(`${name} must be a positive safe integer no greater than ${MAX_TIMEOUT_MS}`);
  }
  return value;
}

function validatePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function controlErrorMessage(kind: RuntimeHostControlErrorKind): string {
  switch (kind) {
    case 'command-invalid':
      return 'Runtime-host control command is invalid.';
    case 'frame-too-large':
      return 'Runtime-host control frame exceeds the maximum size.';
    case 'pending-capacity-exceeded':
      return 'Runtime-host control pending command capacity is exhausted.';
    case 'timeout-exceeded':
      return 'Runtime-host control command timeout elapsed.';
    case 'disconnected':
      return 'Runtime-host control stream disconnected.';
    case 'write-failed':
      return 'Runtime-host control write failed.';
    case 'protocol-invalid':
      return 'Runtime-host control stream violated protocol v1.';
  }
}
