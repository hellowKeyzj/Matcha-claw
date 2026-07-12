import {
  validateRuntimeEndpointRef,
  validateRuntimeScope,
  type RuntimeEndpointRef,
  type RuntimeScope,
} from '../agent-runtime/contracts/runtime-address';
import type { CapabilityDescriptor } from '../capabilities/contracts/capability-descriptor';
import type { RemoteFleetRuntimeKind } from './remote-fleet-model';

export type RuntimeAgentCredentialInput =
  | {
      readonly kind: 'bearer-token';
      readonly token: string;
      readonly credentialId?: string;
    }
  | {
      readonly kind: 'shared-secret';
      readonly secret: string;
      readonly credentialId?: string;
    }
  | {
      readonly kind: 'credential-reference';
      readonly referenceId: string;
      readonly credentialId?: string;
    };

export type RuntimeAgentCredentialProjection =
  | {
      readonly credentialType: 'provided';
      readonly credentialId?: string;
    }
  | {
      readonly credentialType: 'reference';
      readonly credentialId?: string;
    };

export interface RuntimeAgentTransportTarget {
  readonly endpointUrl: string;
  readonly credential: RuntimeAgentCredentialInput;
  readonly timeoutMs?: number;
}

export interface RuntimeAgentClientTargetSnapshot {
  readonly endpointUrl: string;
  readonly credential: RuntimeAgentCredentialProjection;
  readonly timeoutMs?: number;
}

export type RuntimeAgentRequestType =
  | 'runtime-agent.heartbeat'
  | 'runtime-agent.command.accept'
  | 'runtime-agent.command.progress'
  | 'runtime-agent.command.result'
  | 'runtime-agent.capabilities.sync'
  | 'runtime-agent.runtime.start'
  | 'runtime-agent.runtime.stop';

export type RuntimeAgentLifecycleStatus =
  | 'starting'
  | 'running'
  | 'draining'
  | 'stopping'
  | 'stopped'
  | 'degraded';

export interface RuntimeAgentRequestBase {
  readonly type: RuntimeAgentRequestType;
  readonly requestId: string;
  readonly agentId: string;
  readonly sentAt: string;
}

export interface RuntimeAgentHeartbeatRequest extends RuntimeAgentRequestBase {
  readonly type: 'runtime-agent.heartbeat';
  readonly observedAt: string;
  readonly status: RuntimeAgentLifecycleStatus;
  readonly runtimeIds?: readonly string[];
  readonly message?: string;
}

export interface RuntimeAgentAcceptCommandRequest extends RuntimeAgentRequestBase {
  readonly type: 'runtime-agent.command.accept';
  readonly commandId: string;
  readonly commandName: string;
  readonly issuedAt: string;
  readonly idempotencyKey?: string;
  readonly payload?: unknown;
}

export interface RuntimeAgentReportCommandProgressRequest extends RuntimeAgentRequestBase {
  readonly type: 'runtime-agent.command.progress';
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly progress: RuntimeAgentCommandProgress;
}

export interface RuntimeAgentReportCommandResultRequest extends RuntimeAgentRequestBase {
  readonly type: 'runtime-agent.command.result';
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly result: RuntimeAgentCommandResult;
}

export interface RuntimeAgentSyncCapabilitiesRequest extends RuntimeAgentRequestBase {
  readonly type: 'runtime-agent.capabilities.sync';
  readonly endpointId: string;
  readonly scope: RuntimeScope;
  readonly descriptors: readonly CapabilityDescriptor[];
  readonly observedAt: string;
}

export interface RuntimeAgentStartRuntimeRequest extends RuntimeAgentRequestBase {
  readonly type: 'runtime-agent.runtime.start';
  readonly runtimeId: string;
  readonly runtimeKind: RemoteFleetRuntimeKind;
  readonly endpointRef?: RuntimeEndpointRef;
}

export interface RuntimeAgentStopRuntimeRequest extends RuntimeAgentRequestBase {
  readonly type: 'runtime-agent.runtime.stop';
  readonly runtimeId: string;
  readonly reason?: string;
}

export type RuntimeAgentClientRequest =
  | RuntimeAgentHeartbeatRequest
  | RuntimeAgentAcceptCommandRequest
  | RuntimeAgentReportCommandProgressRequest
  | RuntimeAgentReportCommandResultRequest
  | RuntimeAgentSyncCapabilitiesRequest
  | RuntimeAgentStartRuntimeRequest
  | RuntimeAgentStopRuntimeRequest;

export interface RuntimeAgentCommandProgress {
  readonly state: 'queued' | 'running';
  readonly phase?: string;
  readonly message?: string;
  readonly percent?: number;
}

export type RuntimeAgentCommandResult =
  | {
      readonly reason: 'succeeded';
      readonly completedAt: string;
    }
  | {
      readonly reason: 'failed';
      readonly completedAt: string;
      readonly message: string;
    }
  | {
      readonly reason: 'cancelled';
      readonly completedAt: string;
      readonly message?: string;
    }
  | {
      readonly reason: 'timed-out';
      readonly completedAt: string;
      readonly timeoutMs: number;
    };

export interface RuntimeAgentHeartbeatSnapshot {
  readonly agentId: string;
  readonly status: RuntimeAgentLifecycleStatus;
  readonly observedAt: string;
  readonly runtimeIds: readonly string[];
  readonly message?: string;
}

export type RuntimeAgentResponseRejectionReason =
  | 'invalid-request'
  | 'unauthorized'
  | 'unsupported-operation'
  | 'runtime-unavailable'
  | 'command-conflict'
  | 'rate-limited';

export interface RuntimeAgentRejectedResponse<TType extends string> {
  readonly type: TType;
  readonly requestId: string;
  readonly agentId?: string;
  readonly resultType: 'rejected';
  readonly reason: RuntimeAgentResponseRejectionReason;
  readonly message: string;
  readonly receivedAt?: string;
  readonly retryAfterMs?: number;
}

export type RuntimeAgentHeartbeatResponse =
  | {
      readonly type: 'runtime-agent.heartbeat.response';
      readonly requestId: string;
      readonly agentId: string;
      readonly resultType: 'recorded';
      readonly receivedAt: string;
      readonly snapshot: RuntimeAgentHeartbeatSnapshot;
    }
  | RuntimeAgentRejectedResponse<'runtime-agent.heartbeat.response'>;

export type RuntimeAgentAcceptCommandResponse =
  | {
      readonly type: 'runtime-agent.command.accept.response';
      readonly requestId: string;
      readonly agentId: string;
      readonly commandId: string;
      readonly resultType: 'accepted';
      readonly acceptedAt: string;
    }
  | RuntimeAgentRejectedResponse<'runtime-agent.command.accept.response'>;

export type RuntimeAgentReportCommandProgressResponse =
  | {
      readonly type: 'runtime-agent.command.progress.response';
      readonly requestId: string;
      readonly agentId: string;
      readonly commandId: string;
      readonly resultType: 'recorded';
      readonly recordedAt: string;
    }
  | RuntimeAgentRejectedResponse<'runtime-agent.command.progress.response'>;

export type RuntimeAgentReportCommandResultResponse =
  | {
      readonly type: 'runtime-agent.command.result.response';
      readonly requestId: string;
      readonly agentId: string;
      readonly commandId: string;
      readonly resultType: 'recorded';
      readonly recordedAt: string;
    }
  | RuntimeAgentRejectedResponse<'runtime-agent.command.result.response'>;

export type RuntimeAgentSyncCapabilitiesResponse =
  | {
      readonly type: 'runtime-agent.capabilities.sync.response';
      readonly requestId: string;
      readonly agentId: string;
      readonly endpointId: string;
      readonly resultType: 'synced';
      readonly syncedAt: string;
      readonly descriptorCount: number;
    }
  | RuntimeAgentRejectedResponse<'runtime-agent.capabilities.sync.response'>;

export type RuntimeAgentStartRuntimeResponse =
  | {
      readonly type: 'runtime-agent.runtime.start.response';
      readonly requestId: string;
      readonly agentId: string;
      readonly runtimeId: string;
      readonly resultType: 'started';
      readonly startedAt: string;
    }
  | RuntimeAgentRejectedResponse<'runtime-agent.runtime.start.response'>;

export type RuntimeAgentStopRuntimeResponse =
  | {
      readonly type: 'runtime-agent.runtime.stop.response';
      readonly requestId: string;
      readonly agentId: string;
      readonly runtimeId: string;
      readonly resultType: 'stopped';
      readonly stoppedAt: string;
    }
  | RuntimeAgentRejectedResponse<'runtime-agent.runtime.stop.response'>;

export type RuntimeAgentClientResponse =
  | RuntimeAgentHeartbeatResponse
  | RuntimeAgentAcceptCommandResponse
  | RuntimeAgentReportCommandProgressResponse
  | RuntimeAgentReportCommandResultResponse
  | RuntimeAgentSyncCapabilitiesResponse
  | RuntimeAgentStartRuntimeResponse
  | RuntimeAgentStopRuntimeResponse;

export type RuntimeAgentClientFailureReason =
  | 'invalid-request'
  | 'invalid-response'
  | 'authentication-failed'
  | 'transport-unavailable'
  | 'timeout'
  | 'remote-rejected';

export type RuntimeAgentClientCallResult<TResponse extends RuntimeAgentClientResponse = RuntimeAgentClientResponse> =
  | {
      readonly resultType: 'delivered';
      readonly response: TResponse;
    }
  | {
      readonly resultType: 'failed';
      readonly reason: RuntimeAgentClientFailureReason;
      readonly message: string;
      readonly retryAfterMs?: number;
    };

export interface RuntimeAgentTransportRequest {
  readonly target: RuntimeAgentTransportTarget;
  readonly request: RuntimeAgentClientRequest;
}

export interface RuntimeAgentTransport {
  request(input: RuntimeAgentTransportRequest): Promise<RuntimeAgentClientCallResult>;
}

export interface RuntimeAgentClientPort {
  heartbeat(input: RuntimeAgentClientCall<RuntimeAgentHeartbeatRequest>): Promise<RuntimeAgentClientCallResult<RuntimeAgentHeartbeatResponse>>;
  acceptCommand(input: RuntimeAgentClientCall<RuntimeAgentAcceptCommandRequest>): Promise<RuntimeAgentClientCallResult<RuntimeAgentAcceptCommandResponse>>;
  reportCommandProgress(
    input: RuntimeAgentClientCall<RuntimeAgentReportCommandProgressRequest>,
  ): Promise<RuntimeAgentClientCallResult<RuntimeAgentReportCommandProgressResponse>>;
  reportCommandResult(
    input: RuntimeAgentClientCall<RuntimeAgentReportCommandResultRequest>,
  ): Promise<RuntimeAgentClientCallResult<RuntimeAgentReportCommandResultResponse>>;
  syncCapabilities(input: RuntimeAgentClientCall<RuntimeAgentSyncCapabilitiesRequest>): Promise<RuntimeAgentClientCallResult<RuntimeAgentSyncCapabilitiesResponse>>;
  startRuntime(input: RuntimeAgentClientCall<RuntimeAgentStartRuntimeRequest>): Promise<RuntimeAgentClientCallResult<RuntimeAgentStartRuntimeResponse>>;
  stopRuntime(input: RuntimeAgentClientCall<RuntimeAgentStopRuntimeRequest>): Promise<RuntimeAgentClientCallResult<RuntimeAgentStopRuntimeResponse>>;
}

export interface RuntimeAgentClientCall<TRequest extends RuntimeAgentClientRequest> {
  readonly target: RuntimeAgentTransportTarget;
  readonly request: TRequest;
}

export type RuntimeAgentValidationFailureReason =
  | 'missing-required-field'
  | 'invalid-field-type'
  | 'empty-string'
  | 'invalid-url'
  | 'invalid-timeout'
  | 'invalid-request-type'
  | 'invalid-lifecycle-status'
  | 'invalid-runtime-kind'
  | 'invalid-progress'
  | 'invalid-command-result'
  | 'invalid-credential'
  | 'unsafe-snapshot';

export type RuntimeAgentValidationResult<TValue> =
  | {
      readonly resultType: 'valid';
      readonly value: TValue;
    }
  | {
      readonly resultType: 'invalid';
      readonly reason: RuntimeAgentValidationFailureReason;
      readonly field: string;
      readonly message: string;
    };

const RUNTIME_AGENT_REQUEST_TYPES: readonly RuntimeAgentRequestType[] = [
  'runtime-agent.heartbeat',
  'runtime-agent.command.accept',
  'runtime-agent.command.progress',
  'runtime-agent.command.result',
  'runtime-agent.capabilities.sync',
  'runtime-agent.runtime.start',
  'runtime-agent.runtime.stop',
];

const RUNTIME_AGENT_LIFECYCLE_STATUSES: readonly RuntimeAgentLifecycleStatus[] = [
  'starting',
  'running',
  'draining',
  'stopping',
  'stopped',
  'degraded',
];

const REMOTE_FLEET_RUNTIME_KINDS: readonly RemoteFleetRuntimeKind[] = [
  'openclaw',
  'matcha-agent',
  'plugin-runtime',
];

const RUNTIME_AGENT_COMMAND_PROGRESS_STATES: readonly RuntimeAgentCommandProgress['state'][] = ['queued', 'running'];
const RUNTIME_AGENT_COMMAND_RESULT_REASONS: readonly RuntimeAgentCommandResult['reason'][] = [
  'succeeded',
  'failed',
  'cancelled',
  'timed-out',
];
const PLAIN_CREDENTIAL_FIELD_NAMES = new Set([
  'token',
  'secret',
  'password',
  'authorization',
  'apikey',
  'api_key',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
]);

export function normalizeRuntimeAgentClientTarget(input: unknown): RuntimeAgentValidationResult<RuntimeAgentClientTargetSnapshot> {
  if (!isRecord(input)) {
    return invalid('invalid-field-type', 'target', 'Runtime agent target must be an object.');
  }

  const endpointUrl = readRequiredString(input, 'endpointUrl');
  if (endpointUrl.resultType === 'invalid') {
    return endpointUrl;
  }
  if (!isHttpUrl(endpointUrl.value)) {
    return invalid('invalid-url', 'endpointUrl', 'Runtime agent endpointUrl must be an http(s) URL.');
  }

  const credential = normalizeRuntimeAgentCredentialProjection(input.credential);
  if (credential.resultType === 'invalid') {
    return credential;
  }

  const timeoutMs = normalizeOptionalPositiveInteger(input, 'timeoutMs');
  if (timeoutMs.resultType === 'invalid') {
    return timeoutMs;
  }

  return valid({
    endpointUrl: endpointUrl.value,
    credential: credential.value,
    ...(timeoutMs.value === undefined ? {} : { timeoutMs: timeoutMs.value }),
  });
}

export function normalizeRuntimeAgentCredentialProjection(input: unknown): RuntimeAgentValidationResult<RuntimeAgentCredentialProjection> {
  if (!isRecord(input)) {
    return invalid('invalid-credential', 'credential', 'Runtime agent credential must be an object.');
  }

  const credentialId = normalizeOptionalString(input, 'credentialId');
  if (credentialId.resultType === 'invalid') {
    return credentialId;
  }

  if (input.kind === 'bearer-token') {
    const token = readRequiredString(input, 'token');
    if (token.resultType === 'invalid') {
      return token;
    }
    return valid({
      credentialType: 'provided',
      ...(credentialId.value === undefined ? {} : { credentialId: credentialId.value }),
    });
  }

  if (input.kind === 'shared-secret') {
    const secret = readRequiredString(input, 'secret');
    if (secret.resultType === 'invalid') {
      return secret;
    }
    return valid({
      credentialType: 'provided',
      ...(credentialId.value === undefined ? {} : { credentialId: credentialId.value }),
    });
  }

  if (input.kind === 'credential-reference') {
    const referenceId = readRequiredString(input, 'referenceId');
    if (referenceId.resultType === 'invalid') {
      return referenceId;
    }
    return valid({
      credentialType: 'reference',
      ...(credentialId.value === undefined ? {} : { credentialId: credentialId.value }),
    });
  }

  return invalid('invalid-credential', 'credential.kind', 'Runtime agent credential kind is not supported.');
}

export function normalizeRuntimeAgentClientRequest(input: unknown): RuntimeAgentValidationResult<RuntimeAgentClientRequest> {
  const base = normalizeRuntimeAgentRequestBase(input);
  if (base.resultType === 'invalid') {
    return base;
  }

  switch (base.value.type) {
    case 'runtime-agent.heartbeat':
      return normalizeHeartbeatRequest(base.value);
    case 'runtime-agent.command.accept':
      return normalizeAcceptCommandRequest(base.value);
    case 'runtime-agent.command.progress':
      return normalizeReportCommandProgressRequest(base.value);
    case 'runtime-agent.command.result':
      return normalizeReportCommandResultRequest(base.value);
    case 'runtime-agent.capabilities.sync':
      return normalizeSyncCapabilitiesRequest(base.value);
    case 'runtime-agent.runtime.start':
      return normalizeStartRuntimeRequest(base.value);
    case 'runtime-agent.runtime.stop':
      return normalizeStopRuntimeRequest(base.value);
  }
}

export function validateRuntimeAgentClientRequest(input: unknown): RuntimeAgentValidationResult<RuntimeAgentClientRequest> {
  return normalizeRuntimeAgentClientRequest(input);
}

export function validateRuntimeAgentSnapshotProjection(input: unknown): RuntimeAgentValidationResult<unknown> {
  const unsafeFieldPath = findPlainCredentialFieldPath(input);
  if (unsafeFieldPath) {
    return invalid('unsafe-snapshot', unsafeFieldPath, 'Runtime agent snapshot projection must not expose plaintext credential fields.');
  }
  return valid(input);
}

interface NormalizedRuntimeAgentRequestBase extends RuntimeAgentRequestBase {
  readonly record: Record<string, unknown>;
}

function normalizeRuntimeAgentRequestBase(input: unknown): RuntimeAgentValidationResult<NormalizedRuntimeAgentRequestBase> {
  if (!isRecord(input)) {
    return invalid('invalid-field-type', 'request', 'Runtime agent request must be an object.');
  }

  const type = readRequiredString(input, 'type');
  if (type.resultType === 'invalid') {
    return type;
  }
  if (!isRuntimeAgentRequestType(type.value)) {
    return invalid('invalid-request-type', 'type', 'Runtime agent request type is not supported.');
  }

  const requestId = readRequiredString(input, 'requestId');
  if (requestId.resultType === 'invalid') {
    return requestId;
  }
  const agentId = readRequiredString(input, 'agentId');
  if (agentId.resultType === 'invalid') {
    return agentId;
  }
  const sentAt = readRequiredString(input, 'sentAt');
  if (sentAt.resultType === 'invalid') {
    return sentAt;
  }

  return valid({
    type: type.value,
    requestId: requestId.value,
    agentId: agentId.value,
    sentAt: sentAt.value,
    record: input,
  });
}

function normalizeHeartbeatRequest(base: NormalizedRuntimeAgentRequestBase): RuntimeAgentValidationResult<RuntimeAgentHeartbeatRequest> {
  const observedAt = readRequiredString(base.record, 'observedAt');
  if (observedAt.resultType === 'invalid') {
    return observedAt;
  }
  const status = readRequiredString(base.record, 'status');
  if (status.resultType === 'invalid') {
    return status;
  }
  if (!isRuntimeAgentLifecycleStatus(status.value)) {
    return invalid('invalid-lifecycle-status', 'status', 'Runtime agent heartbeat status is not supported.');
  }
  const runtimeIds = normalizeOptionalStringArray(base.record, 'runtimeIds');
  if (runtimeIds.resultType === 'invalid') {
    return runtimeIds;
  }
  const message = normalizeOptionalString(base.record, 'message');
  if (message.resultType === 'invalid') {
    return message;
  }

  return valid({
    type: 'runtime-agent.heartbeat',
    requestId: base.requestId,
    agentId: base.agentId,
    sentAt: base.sentAt,
    observedAt: observedAt.value,
    status: status.value,
    ...(runtimeIds.value === undefined ? {} : { runtimeIds: runtimeIds.value }),
    ...(message.value === undefined ? {} : { message: message.value }),
  });
}

function normalizeAcceptCommandRequest(base: NormalizedRuntimeAgentRequestBase): RuntimeAgentValidationResult<RuntimeAgentAcceptCommandRequest> {
  const commandId = readRequiredString(base.record, 'commandId');
  if (commandId.resultType === 'invalid') {
    return commandId;
  }
  const commandName = readRequiredString(base.record, 'commandName');
  if (commandName.resultType === 'invalid') {
    return commandName;
  }
  const issuedAt = readRequiredString(base.record, 'issuedAt');
  if (issuedAt.resultType === 'invalid') {
    return issuedAt;
  }
  const idempotencyKey = normalizeOptionalString(base.record, 'idempotencyKey');
  if (idempotencyKey.resultType === 'invalid') {
    return idempotencyKey;
  }

  return valid({
    type: 'runtime-agent.command.accept',
    requestId: base.requestId,
    agentId: base.agentId,
    sentAt: base.sentAt,
    commandId: commandId.value,
    commandName: commandName.value,
    issuedAt: issuedAt.value,
    ...(idempotencyKey.value === undefined ? {} : { idempotencyKey: idempotencyKey.value }),
    ...(Object.hasOwn(base.record, 'payload') ? { payload: base.record.payload } : {}),
  });
}

function normalizeReportCommandProgressRequest(
  base: NormalizedRuntimeAgentRequestBase,
): RuntimeAgentValidationResult<RuntimeAgentReportCommandProgressRequest> {
  const commandId = readRequiredString(base.record, 'commandId');
  if (commandId.resultType === 'invalid') {
    return commandId;
  }
  const idempotencyKey = readRequiredString(base.record, 'idempotencyKey');
  if (idempotencyKey.resultType === 'invalid') {
    return idempotencyKey;
  }
  const progress = normalizeCommandProgress(base.record.progress);
  if (progress.resultType === 'invalid') {
    return progress;
  }

  return valid({
    type: 'runtime-agent.command.progress',
    requestId: base.requestId,
    agentId: base.agentId,
    sentAt: base.sentAt,
    commandId: commandId.value,
    idempotencyKey: idempotencyKey.value,
    progress: progress.value,
  });
}

function normalizeReportCommandResultRequest(
  base: NormalizedRuntimeAgentRequestBase,
): RuntimeAgentValidationResult<RuntimeAgentReportCommandResultRequest> {
  const commandId = readRequiredString(base.record, 'commandId');
  if (commandId.resultType === 'invalid') {
    return commandId;
  }
  const idempotencyKey = readRequiredString(base.record, 'idempotencyKey');
  if (idempotencyKey.resultType === 'invalid') {
    return idempotencyKey;
  }
  const result = normalizeCommandResult(base.record.result);
  if (result.resultType === 'invalid') {
    return result;
  }

  return valid({
    type: 'runtime-agent.command.result',
    requestId: base.requestId,
    agentId: base.agentId,
    sentAt: base.sentAt,
    commandId: commandId.value,
    idempotencyKey: idempotencyKey.value,
    result: result.value,
  });
}

function normalizeSyncCapabilitiesRequest(base: NormalizedRuntimeAgentRequestBase): RuntimeAgentValidationResult<RuntimeAgentSyncCapabilitiesRequest> {
  const endpointId = readRequiredString(base.record, 'endpointId');
  if (endpointId.resultType === 'invalid') {
    return endpointId;
  }
  const scope = normalizeRuntimeScopeField(base.record.scope);
  if (scope.resultType === 'invalid') {
    return scope;
  }
  if (!Array.isArray(base.record.descriptors)) {
    return invalid('invalid-field-type', 'descriptors', 'Runtime agent capability sync descriptors must be an array.');
  }
  const observedAt = readRequiredString(base.record, 'observedAt');
  if (observedAt.resultType === 'invalid') {
    return observedAt;
  }

  return valid({
    type: 'runtime-agent.capabilities.sync',
    requestId: base.requestId,
    agentId: base.agentId,
    sentAt: base.sentAt,
    endpointId: endpointId.value,
    scope: scope.value,
    descriptors: base.record.descriptors as readonly CapabilityDescriptor[],
    observedAt: observedAt.value,
  });
}

function normalizeStartRuntimeRequest(base: NormalizedRuntimeAgentRequestBase): RuntimeAgentValidationResult<RuntimeAgentStartRuntimeRequest> {
  const runtimeId = readRequiredString(base.record, 'runtimeId');
  if (runtimeId.resultType === 'invalid') {
    return runtimeId;
  }
  const runtimeKind = readRequiredString(base.record, 'runtimeKind');
  if (runtimeKind.resultType === 'invalid') {
    return runtimeKind;
  }
  if (!isRemoteFleetRuntimeKind(runtimeKind.value)) {
    return invalid('invalid-runtime-kind', 'runtimeKind', 'Runtime agent runtime kind is not supported.');
  }
  const endpointRef = normalizeOptionalRuntimeEndpointRefField(base.record, 'endpointRef');
  if (endpointRef.resultType === 'invalid') {
    return endpointRef;
  }

  return valid({
    type: 'runtime-agent.runtime.start',
    requestId: base.requestId,
    agentId: base.agentId,
    sentAt: base.sentAt,
    runtimeId: runtimeId.value,
    runtimeKind: runtimeKind.value,
    ...(endpointRef.value === undefined ? {} : { endpointRef: endpointRef.value }),
  });
}

function normalizeStopRuntimeRequest(base: NormalizedRuntimeAgentRequestBase): RuntimeAgentValidationResult<RuntimeAgentStopRuntimeRequest> {
  const runtimeId = readRequiredString(base.record, 'runtimeId');
  if (runtimeId.resultType === 'invalid') {
    return runtimeId;
  }
  const reason = normalizeOptionalString(base.record, 'reason');
  if (reason.resultType === 'invalid') {
    return reason;
  }

  return valid({
    type: 'runtime-agent.runtime.stop',
    requestId: base.requestId,
    agentId: base.agentId,
    sentAt: base.sentAt,
    runtimeId: runtimeId.value,
    ...(reason.value === undefined ? {} : { reason: reason.value }),
  });
}

function normalizeRuntimeScopeField(input: unknown): RuntimeAgentValidationResult<RuntimeScope> {
  const error = validateRuntimeScope(input);
  if (error) {
    return invalid('invalid-field-type', 'scope', error);
  }
  if (!isRuntimeScope(input)) {
    return invalid('invalid-field-type', 'scope', 'RuntimeScope validation did not narrow input.');
  }
  return valid(input);
}

function normalizeOptionalRuntimeEndpointRefField(
  record: Record<string, unknown>,
  field: string,
): RuntimeAgentValidationResult<RuntimeEndpointRef | undefined> {
  if (!Object.hasOwn(record, field) || record[field] === undefined) {
    return valid(undefined);
  }
  const candidate = record[field];
  const error = validateRuntimeEndpointRef(candidate);
  if (error) {
    return invalid('invalid-field-type', field, error);
  }
  if (!isRuntimeEndpointRef(candidate)) {
    return invalid('invalid-field-type', field, 'RuntimeEndpointRef validation did not narrow input.');
  }
  return valid(candidate);
}

function normalizeCommandProgress(input: unknown): RuntimeAgentValidationResult<RuntimeAgentCommandProgress> {
  if (!isRecord(input)) {
    return invalid('invalid-progress', 'progress', 'Runtime agent command progress must be an object.');
  }
  const state = readRequiredString(input, 'state');
  if (state.resultType === 'invalid') {
    return state;
  }
  if (!isCommandProgressState(state.value)) {
    return invalid('invalid-progress', 'progress.state', 'Runtime agent command progress state is not supported.');
  }
  const percent = normalizeOptionalPercent(input, 'percent');
  if (percent.resultType === 'invalid') {
    return percent;
  }
  const phase = normalizeOptionalString(input, 'phase');
  if (phase.resultType === 'invalid') {
    return phase;
  }
  const message = normalizeOptionalString(input, 'message');
  if (message.resultType === 'invalid') {
    return message;
  }

  return valid({
    state: state.value,
    ...(phase.value === undefined ? {} : { phase: phase.value }),
    ...(message.value === undefined ? {} : { message: message.value }),
    ...(percent.value === undefined ? {} : { percent: percent.value }),
  });
}

function normalizeCommandResult(input: unknown): RuntimeAgentValidationResult<RuntimeAgentCommandResult> {
  if (!isRecord(input)) {
    return invalid('invalid-command-result', 'result', 'Runtime agent command result must be an object.');
  }
  for (const field of ['output', 'stdout', 'stderr'] as const) {
    if (Object.hasOwn(input, field)) {
      return invalid('invalid-command-result', `result.${field}`, 'Runtime agent command result output is not supported.');
    }
  }
  const reason = readRequiredString(input, 'reason');
  if (reason.resultType === 'invalid') {
    return reason;
  }
  if (!isCommandResultReason(reason.value)) {
    return invalid('invalid-command-result', 'result.reason', 'Runtime agent command result reason is not supported.');
  }
  const completedAt = readRequiredString(input, 'completedAt');
  if (completedAt.resultType === 'invalid') {
    return completedAt;
  }

  switch (reason.value) {
    case 'succeeded':
      if (Object.hasOwn(input, 'output')) {
        return invalid('invalid-command-result', 'result.output', 'Runtime agent command result output is not supported.');
      }
      return valid({ reason: 'succeeded', completedAt: completedAt.value });
    case 'failed': {
      const message = readRequiredString(input, 'message');
      if (message.resultType === 'invalid') {
        return message;
      }
      return valid({ reason: 'failed', completedAt: completedAt.value, message: message.value });
    }
    case 'cancelled': {
      const message = normalizeOptionalString(input, 'message');
      if (message.resultType === 'invalid') {
        return message;
      }
      return valid({
        reason: 'cancelled',
        completedAt: completedAt.value,
        ...(message.value === undefined ? {} : { message: message.value }),
      });
    }
    case 'timed-out': {
      const timeoutMs = normalizeOptionalPositiveInteger(input, 'timeoutMs');
      if (timeoutMs.resultType === 'invalid') {
        return timeoutMs;
      }
      if (timeoutMs.value === undefined) {
        return invalid('missing-required-field', 'timeoutMs', 'Runtime agent timed-out command result requires timeoutMs.');
      }
      return valid({ reason: 'timed-out', completedAt: completedAt.value, timeoutMs: timeoutMs.value });
    }
  }
}

function readRequiredString(record: Record<string, unknown>, field: string): RuntimeAgentValidationResult<string> {
  if (!Object.hasOwn(record, field)) {
    return invalid('missing-required-field', field, `Runtime agent field ${field} is required.`);
  }
  if (typeof record[field] !== 'string') {
    return invalid('invalid-field-type', field, `Runtime agent field ${field} must be a string.`);
  }
  const value = record[field].trim();
  if (!value) {
    return invalid('empty-string', field, `Runtime agent field ${field} must not be empty.`);
  }
  return valid(value);
}

function normalizeOptionalString(record: Record<string, unknown>, field: string): RuntimeAgentValidationResult<string | undefined> {
  if (!Object.hasOwn(record, field) || record[field] === undefined) {
    return valid(undefined);
  }
  if (typeof record[field] !== 'string') {
    return invalid('invalid-field-type', field, `Runtime agent field ${field} must be a string when provided.`);
  }
  const value = record[field].trim();
  if (!value) {
    return invalid('empty-string', field, `Runtime agent field ${field} must not be empty when provided.`);
  }
  return valid(value);
}

function normalizeOptionalStringArray(record: Record<string, unknown>, field: string): RuntimeAgentValidationResult<readonly string[] | undefined> {
  if (!Object.hasOwn(record, field) || record[field] === undefined) {
    return valid(undefined);
  }
  if (!Array.isArray(record[field])) {
    return invalid('invalid-field-type', field, `Runtime agent field ${field} must be an array when provided.`);
  }

  const values: string[] = [];
  for (const [index, item] of record[field].entries()) {
    if (typeof item !== 'string') {
      return invalid('invalid-field-type', `${field}.${index}`, `Runtime agent field ${field}.${index} must be a string.`);
    }
    const value = item.trim();
    if (!value) {
      return invalid('empty-string', `${field}.${index}`, `Runtime agent field ${field}.${index} must not be empty.`);
    }
    values.push(value);
  }
  return valid(values);
}

function normalizeOptionalPositiveInteger(record: Record<string, unknown>, field: string): RuntimeAgentValidationResult<number | undefined> {
  if (!Object.hasOwn(record, field) || record[field] === undefined) {
    return valid(undefined);
  }
  if (!Number.isInteger(record[field]) || Number(record[field]) <= 0) {
    return invalid('invalid-timeout', field, `Runtime agent field ${field} must be a positive integer when provided.`);
  }
  return valid(Number(record[field]));
}

function normalizeOptionalPercent(record: Record<string, unknown>, field: string): RuntimeAgentValidationResult<number | undefined> {
  if (!Object.hasOwn(record, field) || record[field] === undefined) {
    return valid(undefined);
  }
  if (typeof record[field] !== 'number' || !Number.isFinite(record[field]) || record[field] < 0 || record[field] > 100) {
    return invalid('invalid-progress', field, `Runtime agent field ${field} must be a number between 0 and 100 when provided.`);
  }
  return valid(record[field]);
}

function findPlainCredentialFieldPath(input: unknown, path = 'snapshot'): string | undefined {
  if (Array.isArray(input)) {
    for (const [index, item] of input.entries()) {
      const fieldPath = findPlainCredentialFieldPath(item, `${path}.${index}`);
      if (fieldPath) {
        return fieldPath;
      }
    }
    return undefined;
  }
  if (!isRecord(input)) {
    return undefined;
  }

  for (const [key, value] of Object.entries(input)) {
    if (PLAIN_CREDENTIAL_FIELD_NAMES.has(normalizeCredentialFieldName(key))) {
      return `${path}.${key}`;
    }
    const fieldPath = findPlainCredentialFieldPath(value, `${path}.${key}`);
    if (fieldPath) {
      return fieldPath;
    }
  }
  return undefined;
}

function normalizeCredentialFieldName(value: string): string {
  return value.toLowerCase().replace(/[-\s]/g, '_');
}

function isRuntimeScope(input: unknown): input is RuntimeScope {
  return validateRuntimeScope(input) === null;
}

function isRuntimeEndpointRef(input: unknown): input is RuntimeEndpointRef {
  return validateRuntimeEndpointRef(input) === null;
}

function isRuntimeAgentRequestType(value: string): value is RuntimeAgentRequestType {
  return RUNTIME_AGENT_REQUEST_TYPES.includes(value as RuntimeAgentRequestType);
}

function isRuntimeAgentLifecycleStatus(value: string): value is RuntimeAgentLifecycleStatus {
  return RUNTIME_AGENT_LIFECYCLE_STATUSES.includes(value as RuntimeAgentLifecycleStatus);
}

function isRemoteFleetRuntimeKind(value: string): value is RemoteFleetRuntimeKind {
  return REMOTE_FLEET_RUNTIME_KINDS.includes(value as RemoteFleetRuntimeKind);
}

function isCommandProgressState(value: string): value is RuntimeAgentCommandProgress['state'] {
  return RUNTIME_AGENT_COMMAND_PROGRESS_STATES.includes(value as RuntimeAgentCommandProgress['state']);
}

function isCommandResultReason(value: string): value is RuntimeAgentCommandResult['reason'] {
  return RUNTIME_AGENT_COMMAND_RESULT_REASONS.includes(value as RuntimeAgentCommandResult['reason']);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function valid<TValue>(value: TValue): RuntimeAgentValidationResult<TValue> {
  return { resultType: 'valid', value };
}

function invalid<TValue>(
  reason: RuntimeAgentValidationFailureReason,
  field: string,
  message: string,
): RuntimeAgentValidationResult<TValue> {
  return { resultType: 'invalid', reason, field, message };
}
