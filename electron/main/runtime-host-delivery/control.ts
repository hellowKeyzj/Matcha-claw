import { randomUUID } from 'node:crypto';
import type { AccessPolicyRef, AccessScope, Effect, PolicyRule, RetentionPolicy, Timestamp, WorldRef } from '../../../src/types/world';
import { decodeBoardChangedEvent, decodeBoardCommandEvent, type BoardChangedEvent, type BoardCommandEvent } from '../../../src/types/board';
import { isProductRuntimeEndpoint, type ProductRuntimeEndpoint } from './transport/runtime-scope';
import {
  isWorldChangedEvent, isWorldResyncEvent, isWorldRef, type WorldChangedHint, type WorldResyncHint,
} from '../world/events';

export const RUNTIME_HOST_CONTROL_VERSION = 1;
export const MAX_RUNTIME_HOST_CONTROL_FRAME_BYTES = 1024 * 1024;

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_REQUEST_ID_BYTES = 128;
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

export type WorldStorageTransferCut = Readonly<{
  world: Readonly<{ tenantId: string; worldId: string }>;
  transferId: string;
  sourceStorageId: string;
  targetStorageId: string;
  sourceEpoch: string;
  targetEpoch: string;
}>;
export type WorldStorageTransferPrepare = Readonly<{
  world: Readonly<{ tenantId: string; worldId: string }>;
  targetStorageId: string;
  transferId: string;
}>;
export type WorldStorageTransferRequest = Readonly<{
  action: 'resume' | 'abort';
  cut: WorldStorageTransferCut;
}>;
export type WorldAccessGrantRequest = Readonly<{
  world: WorldRef;
  commitId: string;
  id: string;
  actor: Readonly<{ kind: 'human' | 'service'; id: string }>;
  access: ReadonlyArray<AccessScope>;
  labels: ReadonlyArray<string>;
  effects: ReadonlyArray<Effect>;
  expiresAt?: Timestamp | null;
}>;
export type WorldEvaluationConfiguration = Readonly<{
  world: WorldRef;
  commitId: string;
  evaluation: Readonly<{
    execution: Readonly<{ issuer: string; subject: string }>;
    oracle: Readonly<{ issuer: string; subject: string }>;
    caseAccess: AccessPolicyRef;
    caseRetention: RetentionPolicy;
  }>;
  principals: ReadonlyArray<Readonly<{
    issuer: string; subject: string; actor: WorldAccessGrantRequest['actor']; expiresAt?: Timestamp | null;
  }>>;
  grants: ReadonlyArray<Omit<WorldAccessGrantRequest, 'world' | 'commitId' | 'actor'> & { readonly recipient: 'execution' | 'oracle' }>;
  policies: ReadonlyArray<Readonly<{
    rule: Omit<PolicyRule, 'reference'> & { reference: Omit<PolicyRule['reference'], 'contract'> };
    scope: string; mandatory: boolean; available: boolean;
  }>>;
  retentionPolicies: ReadonlyArray<Readonly<{ scope: string; policy: RetentionPolicy }>>;
}>;
export type IabMatchaCapability = Readonly<{ sessionId: string; instanceId: string; token: string }>;

export type RuntimeHostControlCommand =
  | { readonly name: 'iab.lease.acquire'; readonly input: Readonly<{ capability: IabMatchaCapability; invocationId: string }> }
  | { readonly name: 'iab.lease.wait'; readonly input: Readonly<{ leaseId: string; invocationId: string }> }
  | { readonly name: 'iab.lease.release'; readonly input: Readonly<{ invocationId: string; leaseId?: string; drained: true }> }
  | { readonly name: 'host.health' }
  | { readonly name: 'host.runtime.snapshot' }
  | { readonly name: 'world.storage.connect'; readonly input: Readonly<{ connectionString: string }> }
  | { readonly name: 'world.initial.prepare'; readonly input: Readonly<{ storageId: string; configuration: Readonly<Record<string, unknown>> }> }
  | { readonly name: 'world.initial.provision'; readonly input: Readonly<{ storage: Readonly<{ storageId: string; connectionString: string }>; configuration: Readonly<Record<string, unknown>> }> }
  | { readonly name: 'world.access.grant'; readonly input: WorldAccessGrantRequest }
  | { readonly name: 'world.evaluation.prepare'; readonly input: Readonly<{ world: WorldRef; configuration: WorldEvaluationConfiguration }> }
  | { readonly name: 'world.evaluation.install'; readonly input: WorldEvaluationConfiguration }
  | { readonly name: 'world.evaluation.status'; readonly input: Readonly<{ world: WorldRef }> }
  | { readonly name: 'world.storage.transfer.prepare'; readonly input: WorldStorageTransferPrepare }
  | { readonly name: 'world.storage.transfer'; readonly input: WorldStorageTransferRequest };

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
  | ({ readonly type: 'world.changed' } & Omit<WorldChangedHint, 'kind'>)
  | ({ readonly type: 'world.resync-required' } & Omit<WorldResyncHint, 'kind'>)
  | ({ readonly type: 'board:changed' } & BoardChangedEvent)
  | ({ readonly type: 'board:command' } & BoardCommandEvent)
  | { readonly type: 'board:resync' }
  | { readonly type: 'openclaw.progress.changed' }
  | { readonly type: 'call.changed'; readonly callId: string; readonly revision: number }
  | { readonly type: 'calls.resync' }
  | { readonly type: 'organization.changed' }
  | { readonly type: 'sessions.catalogChanged'; readonly endpoint: ProductRuntimeEndpoint }
  | { readonly type: 'cron.changed'; readonly endpoint: ProductRuntimeEndpoint }
  | {
      readonly type: 'openclaw.lifecycle';
      readonly sequence: number | null;
      readonly hasRun: boolean;
      readonly hasMessage: boolean;
      readonly hasSessionActivity: boolean;
    }
  | { readonly type: 'openclaw.runtime' }
  | { readonly type: 'openclaw.questions.changed' }
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
    };

export type RuntimeHostControlDelivery = 'not-delivered' | 'unknown-delivery';

export type RuntimeHostControlErrorKind =
  | 'command-invalid'
  | 'frame-too-large'
  | 'pending-capacity-exceeded'
  | 'timeout-exceeded'
  | 'disconnected'
  | 'write-failed'
  | 'protocol-invalid'
  | 'provider-migration-failed';

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
  on(
    event: 'close' | 'error',
    listener: (...arguments_: readonly unknown[]) => void,
  ): unknown;
  removeListener(
    event: 'close' | 'error',
    listener: (...arguments_: readonly unknown[]) => void,
  ): unknown;
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
  | { readonly kind: 'startup-failed'; readonly code: 'provider-migration-failed' }
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
  private readonly frameHeader = Buffer.alloc(4);
  private frameBody: Buffer | undefined;
  private frameOffset = 0;
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

    this.stdin.on('error', this.handleInputError);
    this.stdin.on('close', this.handleInputClose);
    this.stdout.on('data', this.handleOutputData);
    this.stdout.on('end', this.handleOutputDisconnect);
    this.stdout.on('close', this.handleOutputClose);
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
          if (error) this.disconnect('write-failed');
        });
      } catch {
        this.disconnect('write-failed');
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

    let offset = 0;
    while (offset < chunk.length && !this.isClosed) {
      if (this.frameBody === undefined) {
        offset = this.copyFrameBytes(chunk, offset, this.frameHeader);
        if (this.frameOffset < 4) return;

        const bodyBytes = this.frameHeader.readUInt32BE(0);
        if (bodyBytes === 0 || bodyBytes > MAX_RUNTIME_HOST_CONTROL_FRAME_BYTES) {
          this.disconnect('protocol-invalid');
          return;
        }
        this.frameBody = Buffer.allocUnsafe(bodyBytes);
        this.frameOffset = 0;
      }

      offset = this.copyFrameBytes(chunk, offset, this.frameBody);
      if (this.frameOffset < this.frameBody.length) return;

      const body = this.frameBody;
      this.frameBody = undefined;
      this.frameOffset = 0;
      const message = decodeIncomingMessage(body);
      if (!message) {
        this.disconnect('protocol-invalid');
        return;
      }
      this.handleIncomingMessage(message);
    }
  };

  private readonly handleInputError = (): void => {
    this.disconnect('write-failed');
  };

  private readonly handleInputClose = (): void => {
    this.disconnect('disconnected');
    this.stdin.removeListener('error', this.handleInputError);
    this.stdin.removeListener('close', this.handleInputClose);
  };

  private readonly handleOutputDisconnect = (): void => {
    this.disconnect('disconnected');
  };

  private readonly handleOutputClose = (): void => {
    this.disconnect('disconnected');
    this.stdout.removeListener('close', this.handleOutputClose);
    this.stdout.removeListener('error', this.handleOutputDisconnect);
  };

  private copyFrameBytes(input: Uint8Array, offset: number, target: Buffer): number {
    const copiedBytes = Math.min(target.length - this.frameOffset, input.length - offset);
    if (copiedBytes > 0) {
      target.set(input.subarray(offset, offset + copiedBytes), this.frameOffset);
      this.frameOffset += copiedBytes;
    }
    return offset + copiedBytes;
  }

  private handleIncomingMessage(message: IncomingMessage): void {
    if (message.kind === 'startup-failed') {
      this.disconnect(this.isReady ? 'protocol-invalid' : message.code);
      return;
    }
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

  private disconnect(kind: Extract<RuntimeHostControlErrorKind, 'disconnected' | 'write-failed' | 'protocol-invalid' | 'provider-migration-failed'>): void {
    if (this.isClosed) return;

    const error = new RuntimeHostControlError(kind, 'not-delivered');
    this.isClosed = true;
    this.disconnectError = error;
    this.frameBody = undefined;
    this.frameOffset = 0;
    this.stdout.removeListener('data', this.handleOutputData);
    this.stdout.removeListener('end', this.handleOutputDisconnect);

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
  if (raw.type === 'startup-failed') {
    return hasExactKeys(raw, ['version', 'type', 'code']) && raw.code === 'provider-migration-failed'
      ? { kind: 'startup-failed', code: raw.code } : undefined;
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
  return { kind: 'event', event: raw.event };
}

export function isRuntimeHostControlCommand(value: unknown): value is RuntimeHostControlCommand & RuntimeHostJsonObject {
  if (!isRecord(value) || !isJsonValue(value) || typeof value.name !== 'string') return false;
  switch (value.name) {
    case 'iab.lease.acquire':
      return hasExactKeys(value, ['name', 'input']) && isRecord(value.input)
        && hasExactKeys(value.input, ['capability', 'invocationId']) && isIabInvocationId(value.input.invocationId)
        && isIabMatchaCapability(value.input.capability);
    case 'iab.lease.wait':
      return hasExactKeys(value, ['name', 'input']) && isRecord(value.input)
        && hasExactKeys(value.input, ['leaseId', 'invocationId'])
        && isIabInvocationId(value.input.leaseId) && isIabInvocationId(value.input.invocationId);
    case 'iab.lease.release':
      return hasExactKeys(value, ['name', 'input']) && isRecord(value.input)
        && hasExactKeys(value.input, ['invocationId', 'drained', ...(Object.hasOwn(value.input, 'leaseId') ? ['leaseId'] : [])])
        && isIabInvocationId(value.input.invocationId) && value.input.drained === true
        && (value.input.leaseId === undefined || isIabInvocationId(value.input.leaseId));
    case 'host.health':
    case 'host.runtime.snapshot':
      return hasExactKeys(value, ['name']);
    case 'world.storage.connect':
      return hasExactKeys(value, ['name', 'input']) && isRecord(value.input)
        && hasExactKeys(value.input, ['connectionString']) && typeof value.input.connectionString === 'string'
        && value.input.connectionString.trim().length > 0 && Buffer.byteLength(value.input.connectionString) <= 64 * 1024
        && !value.input.connectionString.includes('\0');
    case 'world.initial.prepare':
      return hasExactKeys(value, ['name', 'input']) && isRecord(value.input)
        && hasExactKeys(value.input, ['storageId', 'configuration']) && worldIdentifier(value.input.storageId)
        && isRecord(value.input.configuration) && !Object.hasOwn(value.input.configuration, 'storageId');
    case 'world.initial.provision':
      return hasExactKeys(value, ['name', 'input']) && isRecord(value.input)
        && hasExactKeys(value.input, ['storage', 'configuration']) && isRecord(value.input.storage)
        && hasExactKeys(value.input.storage, ['storageId', 'connectionString']) && worldIdentifier(value.input.storage.storageId)
        && typeof value.input.storage.connectionString === 'string' && value.input.storage.connectionString.length > 0
        && isRecord(value.input.configuration) && value.input.configuration.storageId === value.input.storage.storageId;
    case 'world.access.grant':
      return hasExactKeys(value, ['name', 'input']) && isRecord(value.input)
        && hasExactKeys(value.input, ['world', 'commitId', 'id', 'actor', 'access', 'labels', 'effects',
          ...(Object.hasOwn(value.input, 'expiresAt') ? ['expiresAt'] : [])])
        && isWorldRef(value.input.world) && worldIdentifier(value.input.commitId) && worldIdentifier(value.input.id)
        && isRecord(value.input.actor) && hasExactKeys(value.input.actor, ['kind', 'id'])
        && (value.input.actor.kind === 'human' || value.input.actor.kind === 'service')
        && worldIdentifier(value.input.actor.id) && Array.isArray(value.input.access)
        && value.input.access.every((scope) => isRecord(scope) && Array.isArray(scope.resources) && scope.resources.length > 0)
        && Array.isArray(value.input.labels) && value.input.labels.every((label) => typeof label === 'string')
        && Array.isArray(value.input.effects) && value.input.effects.every((effect) =>
          effect === 'pure' || effect === 'source_read' || effect === 'clock_read'
          || effect === 'probabilistic' || effect === 'external_write')
        && (value.input.expiresAt == null || typeof value.input.expiresAt === 'string');
    case 'world.evaluation.prepare':
      return hasExactKeys(value, ['name', 'input']) && isRecord(value.input)
        && hasExactKeys(value.input, ['world', 'configuration']) && isWorldRef(value.input.world)
        && isWorldEvaluationConfiguration(value.input.configuration)
        && value.input.world.tenantId === value.input.configuration.world.tenantId
        && value.input.world.worldId === value.input.configuration.world.worldId;
    case 'world.evaluation.install':
      return hasExactKeys(value, ['name', 'input']) && isWorldEvaluationConfiguration(value.input);
    case 'world.evaluation.status':
      return hasExactKeys(value, ['name', 'input']) && isRecord(value.input)
        && hasExactKeys(value.input, ['world']) && isWorldRef(value.input.world);
    case 'world.storage.transfer.prepare':
      return hasExactKeys(value, ['name', 'input']) && isRecord(value.input)
        && hasExactKeys(value.input, ['world', 'targetStorageId', 'transferId'])
        && isWorldRef(value.input.world) && worldIdentifier(value.input.targetStorageId)
        && worldIdentifier(value.input.transferId);
    case 'world.storage.transfer':
      return hasExactKeys(value, ['name', 'input']) && isRecord(value.input)
        && hasExactKeys(value.input, ['action', 'cut'])
        && (value.input.action === 'resume' || value.input.action === 'abort')
        && isWorldStorageTransferCut(value.input.cut);
    default:
      return false;
  }
}

export function isWorldEvaluationConfiguration(value: unknown): value is WorldEvaluationConfiguration {
  if (!isRecord(value) || !hasExactKeys(value, ['world', 'commitId', 'evaluation', 'principals', 'grants', 'policies', 'retentionPolicies'])
    || !isWorldRef(value.world) || !worldIdentifier(value.commitId) || !isRecord(value.evaluation)
    || !hasExactKeys(value.evaluation, ['execution', 'oracle', 'caseAccess', 'caseRetention'])) return false;
  const principal = (entry: unknown): entry is Record<string, unknown> => isRecord(entry)
    && hasExactKeys(entry, ['issuer', 'subject']) && typeof entry.issuer === 'string' && typeof entry.subject === 'string';
  const retention = (entry: unknown): boolean => isRecord(entry) && hasExactKeys(entry, ['policyId', 'revision'])
    && worldIdentifier(entry.policyId) && worldCounter(entry.revision);
  const strings = (entries: unknown): entries is string[] => Array.isArray(entries) && entries.every((entry) => typeof entry === 'string');
  const effects = (entries: unknown): boolean => Array.isArray(entries) && entries.every((entry) =>
    entry === 'pure' || entry === 'source_read' || entry === 'clock_read' || entry === 'probabilistic' || entry === 'external_write');
  const access = (entries: unknown): boolean => Array.isArray(entries) && entries.every(isEvaluationAccessScope);
  const grant = (entry: unknown): boolean => isRecord(entry)
    && hasExactKeys(entry, ['id', 'recipient', 'access', 'labels', 'effects', ...(Object.hasOwn(entry, 'expiresAt') ? ['expiresAt'] : [])])
    && worldIdentifier(entry.id) && (entry.recipient === 'execution' || entry.recipient === 'oracle')
    && access(entry.access) && strings(entry.labels) && effects(entry.effects)
    && (entry.expiresAt == null || typeof entry.expiresAt === 'string');
  return principal(value.evaluation.execution) && principal(value.evaluation.oracle)
    && isRecord(value.evaluation.caseAccess) && hasExactKeys(value.evaluation.caseAccess, ['policyId', 'revision', 'labels'])
    && worldIdentifier(value.evaluation.caseAccess.policyId) && worldCounter(value.evaluation.caseAccess.revision)
    && strings(value.evaluation.caseAccess.labels) && retention(value.evaluation.caseRetention)
    && Array.isArray(value.principals) && value.principals.every((entry) => isRecord(entry)
      && hasExactKeys(entry, ['issuer', 'subject', 'actor', ...(Object.hasOwn(entry, 'expiresAt') ? ['expiresAt'] : [])])
      && typeof entry.issuer === 'string' && typeof entry.subject === 'string'
      && isRecord(entry.actor) && hasExactKeys(entry.actor, ['kind', 'id'])
      && (entry.actor.kind === 'human' || entry.actor.kind === 'service') && worldIdentifier(entry.actor.id)
      && (entry.expiresAt == null || typeof entry.expiresAt === 'string'))
    && Array.isArray(value.grants) && value.grants.every(grant)
    && Array.isArray(value.policies) && value.policies.every((entry) => isRecord(entry)
      && hasExactKeys(entry, ['rule', 'scope', 'mandatory', 'available']) && worldIdentifier(entry.scope)
      && typeof entry.mandatory === 'boolean' && typeof entry.available === 'boolean'
      && isRecord(entry.rule) && hasExactKeys(entry.rule, ['reference', 'verdict', 'access', 'labels', 'effects'])
      && isRecord(entry.rule.reference) && hasExactKeys(entry.rule.reference, ['policyId', 'revision', 'obligations'])
      && worldIdentifier(entry.rule.reference.policyId) && worldCounter(entry.rule.reference.revision)
      && Array.isArray(entry.rule.reference.obligations) && entry.rule.reference.obligations.every(isEvaluationObligation)
      && (entry.rule.verdict === 'allow' || entry.rule.verdict === 'deny' || entry.rule.verdict === 'needs_approval')
      && access(entry.rule.access) && strings(entry.rule.labels) && effects(entry.rule.effects))
    && Array.isArray(value.retentionPolicies) && value.retentionPolicies.every((entry) => isRecord(entry)
      && hasExactKeys(entry, ['scope', 'policy']) && worldIdentifier(entry.scope) && retention(entry.policy));
}

function isEvaluationAccessScope(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['scope', 'resources', 'fields', 'modes', ...(Object.hasOwn(value, 'validTime') ? ['validTime'] : [])])
    && worldIdentifier(value.scope) && Array.isArray(value.resources)
    && value.resources.every((entry) => isRecord(entry) && (entry.kind === 'head'
      ? hasExactKeys(entry, ['kind', 'channel']) && worldIdentifier(entry.channel)
      : hasExactKeys(entry, ['kind', 'id']) && typeof entry.kind === 'string'
        && ['object', 'relation', 'definition', 'assertion', 'evidence', 'support', 'watch', 'state', 'binding', 'operation',
          'source', 'package', 'change_set', 'branch', 'task', 'case', 'test_case', 'suite', 'evaluation'].includes(entry.kind) && worldIdentifier(entry.id)))
    && Array.isArray(value.fields) && value.fields.every((entry) => isRecord(entry)
      && hasExactKeys(entry, ['id', 'revision', 'world']) && worldIdentifier(entry.id) && worldCounter(entry.revision) && isWorldRef(entry.world))
    && Array.isArray(value.modes) && value.modes.every((entry) => typeof entry === 'string'
      && ['read', 'write', 'execute', 'approve', 'publish', 'manage', 'export', 'delete'].includes(entry))
    && (value.validTime == null || isRecord(value.validTime)
      && hasExactKeys(value.validTime, ['from', ...(Object.hasOwn(value.validTime, 'to') ? ['to'] : [])])
      && typeof value.validTime.from === 'string' && (value.validTime.to == null || typeof value.validTime.to === 'string'));
}

function isEvaluationObligation(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.kind === 'approval' || value.kind === 'audit' || value.kind === 'revalidate_before_effect') return hasExactKeys(value, ['kind']);
  if (value.kind === 'redact') return hasExactKeys(value, ['kind', 'fields']) && Array.isArray(value.fields) && value.fields.every(worldIdentifier);
  return value.kind === 'limit' && hasExactKeys(value, ['kind', 'maximum']) && typeof value.maximum === 'string'
    && /^(0|[1-9][0-9]{0,19})$/.test(value.maximum) && BigInt(value.maximum) <= 18_446_744_073_709_551_615n;
}

function isMutatingCommand(command: RuntimeHostControlCommand): boolean {
  return command.name === 'iab.lease.acquire' || command.name === 'iab.lease.release'
    || command.name === 'world.storage.connect' || command.name === 'world.initial.provision'
    || command.name === 'world.access.grant' || command.name === 'world.evaluation.install'
    || command.name === 'world.storage.transfer.prepare' || command.name === 'world.storage.transfer';
}

export function isWorldStorageTransferCut(value: unknown): value is WorldStorageTransferCut {
  return isRecord(value)
    && hasExactKeys(value, ['world', 'transferId', 'sourceStorageId', 'targetStorageId', 'sourceEpoch', 'targetEpoch'])
    && isWorldRef(value.world) && worldIdentifier(value.transferId)
    && worldIdentifier(value.sourceStorageId) && worldIdentifier(value.targetStorageId)
    && worldEpoch(value.sourceEpoch) && worldEpoch(value.targetEpoch);
}
export function isIabInvocationId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}
export function isIabMatchaCapability(value: unknown): value is IabMatchaCapability {
  return isRecord(value) && hasExactKeys(value, ['sessionId', 'instanceId', 'token'])
    && isIabInvocationId(value.sessionId) && isIabInvocationId(value.instanceId)
    && typeof value.token === 'string' && /^[0-9a-f]{64}$/.test(value.token);
}

function worldIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(value);
}
function worldEpoch(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value)
    && BigInt(value) <= 18_446_744_073_709_551_615n;
}
function worldCounter(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value)
    && BigInt(value) <= 18_446_744_073_709_551_615n;
}

function isRuntimeHostSafeEvent(value: unknown): value is RuntimeHostSafeEvent {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  switch (value.type) {
    case 'world.changed':
      return isWorldChangedEvent(value);
    case 'world.resync-required':
      return isWorldResyncEvent(value);
    case 'board:changed':
    case 'board:command': {
      const { type, ...payload } = value;
      try {
        if (type === 'board:changed') decodeBoardChangedEvent(payload);
        else decodeBoardCommandEvent(payload);
        return true;
      } catch { return false; }
    }
    case 'board:resync':
    case 'openclaw.progress.changed':
      return hasExactKeys(value, ['type']);
    case 'call.changed':
      return hasExactKeys(value, ['type', 'callId', 'revision'])
        && typeof value.callId === 'string'
        && /^[a-f0-9]{32}$/.test(value.callId)
        && isNonNegativeSafeInteger(value.revision)
        && value.revision > 0;
    case 'openclaw.lifecycle':
      return hasExactKeys(value, ['type', 'sequence', 'hasRun', 'hasMessage', 'hasSessionActivity'])
        && (value.sequence === null || isNonNegativeSafeInteger(value.sequence))
        && typeof value.hasRun === 'boolean'
        && typeof value.hasMessage === 'boolean'
        && typeof value.hasSessionActivity === 'boolean';
    case 'calls.resync':
    case 'organization.changed':
    case 'openclaw.runtime':
    case 'openclaw.questions.changed':
      return hasExactKeys(value, ['type']);
    case 'matcha.lifecycle':
      return hasExactKeys(value, ['type', 'lifecycle', 'ready', 'observedAtMs'])
        && isRuntimeHostPeerLifecycle(value.lifecycle)
        && typeof value.ready === 'boolean'
        && isNonNegativeSafeInteger(value.observedAtMs);
    case 'sessions.catalogChanged':
    case 'cron.changed':
      return hasExactKeys(value, ['type', 'endpoint'])
        && isProductRuntimeEndpoint(value.endpoint)
        && value.endpoint.runtimeAdapterId === 'matcha-agent';
    case 'openclaw.cron.execution':
      return hasExactKeys(value, ['type', 'jobId', 'runId', 'status'])
        && isCronExecutionId(value.jobId)
        && isCronExecutionId(value.runId)
        && isCronExecutionStatus(value.status);
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

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
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
    case 'provider-migration-failed':
      return 'Model configuration recovery failed during startup.';
  }
}
