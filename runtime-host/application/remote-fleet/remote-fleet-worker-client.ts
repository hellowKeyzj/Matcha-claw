import { Worker } from 'node:worker_threads';
import type { RuntimeScope } from '../agent-runtime/contracts/runtime-address';
import type { CapabilityDescriptor } from '../capabilities/contracts/capability-descriptor';
import type { RuntimeHostLogger } from '../../shared/logger';
import type { ApplicationResponseOf } from '../common/application-response';
import type { RemoteFleetOperationId } from './remote-fleet-operation-id';
import type { RemoteFleetPort } from './remote-fleet-service';
import type { RemoteFleetCommandDispatchEnvelope } from './remote-fleet-command-dispatch';
import {
  createUnavailableBootstrapResult,
  createUnavailableConnectionProbeResult,
  isRemoteFleetBootstrapCommandResult,
  isRemoteFleetConnectionProbeResult,
  type RemoteFleetBootstrapCommandEnvelope,
  type RemoteFleetBootstrapCommandResult,
  type RemoteFleetBootstrapDispatcherPort,
  type RemoteFleetConnectionProbeEnvelope,
  type RemoteFleetConnectionProbeResult,
} from './remote-fleet-bootstrap';
import {
  REMOTE_FLEET_SECRET_WRITE_HOST_RPC_RESULT_TYPE,
  REMOTE_FLEET_SECRET_WRITE_STATUS_HOST_RPC_RESULT_TYPE,
  isRemoteFleetWritableCredentialName,
  type RemoteFleetCredentialWriteRequestInput,
  type RemoteFleetSecretWriteHostRpcRequest,
  type RemoteFleetSecretWriteHostRpcResponse,
  type RemoteFleetSecretWriteStatusHostRpcRequest,
  type RemoteFleetSecretWriteStatusHostRpcResponse,
  validateCredentialWriteRequest,
  validateCredentialWriteStatusRequest,
} from './remote-fleet-credential-host-rpc';
import {
  REMOTE_FLEET_SECRET_HOST_RPC_RESULT_TYPE,
  type RemoteFleetSecretResolveHostRpcRequest,
  type RemoteFleetSecretResolveHostRpcResponse,
  type RemoteFleetSecretResolveRequestInput,
  type RemoteFleetSecretResolveRequestValidationFailureReason,
  validateSecretResolveRequest,
} from './remote-fleet-secret-host-rpc';
import { evaluateRemoteFleetSecretRefPolicy } from './remote-fleet-secret-policy';
import {
  errorFromRemoteFleetWorker,
  serializeRemoteFleetWorkerError,
} from './remote-fleet-worker-contracts';
import type {
  RemoteFleetHostRequest,
  RemoteFleetHostResponse,
  RemoteFleetMainToWorkerMessage,
  RemoteFleetWorkerConfig,
  RemoteFleetWorkerResponse,
  RemoteFleetWorkerToMainMessage,
} from './remote-fleet-worker-contracts';
import type {
  RemoteFleetTerminalCloseSessionHostRpcRequest,
  RemoteFleetTerminalCloseSessionHostRpcResponse,
  RemoteFleetTerminalCloseSessionRequestInput,
  RemoteFleetTerminalIssueTicketHostRpcRequest,
  RemoteFleetTerminalIssueTicketHostRpcResponse,
  RemoteFleetTerminalIssueTicketRequestInput,
} from './remote-fleet-terminal-contracts';

type RemoteFleetWorkerClientOperationId = RemoteFleetOperationId | 'remote-fleet.close';
type RemoteFleetWorkerClientLogger = Pick<RuntimeHostLogger, 'debug' | 'warn' | 'error'>;

export interface RemoteFleetCapabilityRegistryPort {
  replaceForRuntimeEndpointScope(scope: RuntimeScope, descriptors: Iterable<CapabilityDescriptor>): void;
  removeForRuntimeEndpointScope(scope: RuntimeScope): void;
}

export type RemoteFleetSecretResolveHostRpcResult = RemoteFleetSecretResolveHostRpcResponse extends infer Response
  ? Response extends RemoteFleetSecretResolveHostRpcResponse
    ? Omit<Response, 'type' | 'requestId'>
    : never
  : never;

export interface RemoteFleetSecretResolverPort {
  resolveSecret(input: RemoteFleetSecretResolveRequestInput):
    | Promise<RemoteFleetSecretResolveHostRpcResponse | RemoteFleetSecretResolveHostRpcResult>
    | RemoteFleetSecretResolveHostRpcResponse
    | RemoteFleetSecretResolveHostRpcResult;
}

export type RemoteFleetSecretWriteHostRpcResult = RemoteFleetSecretWriteHostRpcResponse extends infer Response
  ? Response extends RemoteFleetSecretWriteHostRpcResponse
    ? Omit<Response, 'type' | 'requestId'>
    : never
  : never;

export interface RemoteFleetCredentialWriterPort {
  writeCredential(input: RemoteFleetCredentialWriteRequestInput):
    | Promise<RemoteFleetSecretWriteHostRpcResponse | RemoteFleetSecretWriteHostRpcResult | { readonly resultType: 'operationConflict' }>
    | RemoteFleetSecretWriteHostRpcResponse
    | RemoteFleetSecretWriteHostRpcResult
    | { readonly resultType: 'operationConflict' };
  lookupWriteReceipt?(input: RemoteFleetSecretWriteStatusHostRpcRequest['input']):
    | Promise<RemoteFleetSecretWriteStatusHostRpcResponse | Omit<RemoteFleetSecretWriteStatusHostRpcResponse, 'type' | 'requestId'>>
    | RemoteFleetSecretWriteStatusHostRpcResponse
    | Omit<RemoteFleetSecretWriteStatusHostRpcResponse, 'type' | 'requestId'>;
}

export type RemoteFleetRuntimeAgentDispatchResult =
  | {
      readonly resultType: 'accepted';
      readonly accepted: true;
    }
  | {
      readonly resultType: 'unavailable';
      readonly accepted: false;
    };

export interface RemoteFleetRuntimeAgentDispatcherPort {
  dispatchCommand(envelope: RemoteFleetCommandDispatchEnvelope):
    | Promise<RemoteFleetRuntimeAgentDispatchResult>
    | RemoteFleetRuntimeAgentDispatchResult;
}

export interface RemoteFleetTerminalHostPort {
  issueConnectionTicket(input: RemoteFleetTerminalIssueTicketRequestInput):
    | Promise<RemoteFleetTerminalIssueTicketHostRpcResponse>
    | RemoteFleetTerminalIssueTicketHostRpcResponse;
  closeSession(input: RemoteFleetTerminalCloseSessionRequestInput):
    | Promise<RemoteFleetTerminalCloseSessionHostRpcResponse>
    | RemoteFleetTerminalCloseSessionHostRpcResponse;
}

export interface RemoteFleetHostRequestDispatchDeps {
  readonly capabilityRegistry?: RemoteFleetCapabilityRegistryPort;
  readonly secretResolver?: RemoteFleetSecretResolverPort;
  readonly credentialWriter?: RemoteFleetCredentialWriterPort;
  readonly runtimeAgentDispatcher?: RemoteFleetRuntimeAgentDispatcherPort;
  readonly bootstrapDispatcher?: RemoteFleetBootstrapDispatcherPort;
  readonly terminalHost?: RemoteFleetTerminalHostPort;
  readonly logger?: RemoteFleetWorkerClientLogger;
}

interface RemoteFleetWorkerClientDeps extends RemoteFleetHostRequestDispatchDeps {
  readonly workerScriptPath: string;
  readonly config: RemoteFleetWorkerConfig;
}

interface PendingRemoteFleetInvoke {
  readonly resolve: (value: ApplicationResponseOf) => void;
  readonly reject: (error: Error) => void;
  readonly operationId: RemoteFleetWorkerClientOperationId;
  readonly startedAtMs: number;
}

interface RemoteFleetWorkerLogFields {
  readonly requestId?: string;
  readonly operationId?: string;
  readonly hostRequestType?: RemoteFleetHostRequest['type'];
  readonly status: string;
  readonly durationMs?: number;
  readonly pendingCount?: number;
  readonly exitCode?: number;
  readonly errorName?: string;
}

export class WorkerBackedRemoteFleetService implements RemoteFleetPort {
  private readonly worker: Worker;
  private nextRequestId = 0;
  private closed = false;
  private readonly pending = new Map<string, PendingRemoteFleetInvoke>();

  constructor(private readonly deps: RemoteFleetWorkerClientDeps) {
    this.worker = new Worker(deps.workerScriptPath, {
      workerData: deps.config,
    });
    this.logWorkerRpc('worker start', { status: 'started' });
    this.worker.on('message', (message: RemoteFleetWorkerToMainMessage) => {
      void this.handleWorkerMessage(message);
    });
    this.worker.on('error', (error) => {
      this.logWorkerRpc('worker error', { status: 'errored', errorName: safeErrorName(error) });
      this.rejectAll(error instanceof Error ? error : new Error(String(error)));
    });
    this.worker.on('exit', (code) => {
      this.logWorkerRpc('worker exit', { status: 'exited', exitCode: code });
      this.closed = true;
      if (code !== 0) {
        this.rejectAll(new Error(`RemoteFleet worker exited with code ${code}`));
      }
    });
  }

  async invoke(operationId: RemoteFleetOperationId, params: unknown): Promise<ApplicationResponseOf> {
    if (this.closed) {
      this.logWorkerRpc('invoke error', { operationId, status: 'failed', errorName: 'RemoteFleetWorkerClosed' });
      throw new Error('RemoteFleet worker is closed');
    }
    const requestId = `remote-fleet-worker-${++this.nextRequestId}`;
    return await this.sendWorkerRequest(requestId, operationId, {
      type: 'remote-fleet.invoke',
      requestId,
      operationId,
      params,
    });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    const startedAtMs = Date.now();
    this.logWorkerRpc('worker close', { status: 'closing' });
    try {
      await this.invokeWorkerClose();
    } finally {
      this.closed = true;
      await this.worker.terminate();
      this.rejectAll(new Error('RemoteFleet worker closed'));
      this.logWorkerRpc('worker close', { status: 'closed', durationMs: elapsedMsSince(startedAtMs) });
    }
  }

  private async invokeWorkerClose(): Promise<void> {
    const requestId = `remote-fleet-worker-${++this.nextRequestId}`;
    await this.sendWorkerRequest(requestId, 'remote-fleet.close', { type: 'remote-fleet.close', requestId });
  }

  private async sendWorkerRequest(
    requestId: string,
    operationId: RemoteFleetWorkerClientOperationId,
    message: RemoteFleetMainToWorkerMessage,
  ): Promise<ApplicationResponseOf> {
    const startedAtMs = Date.now();
    return await new Promise<ApplicationResponseOf>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject, operationId, startedAtMs });
      try {
        this.worker.postMessage(message);
        this.logWorkerRpc('invoke send', { requestId, operationId, status: 'sent' });
      } catch (error) {
        this.pending.delete(requestId);
        this.logWorkerRpc('invoke error', {
          requestId,
          operationId,
          status: 'failed',
          durationMs: elapsedMsSince(startedAtMs),
          errorName: safeErrorName(error),
        });
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private async handleWorkerMessage(message: RemoteFleetWorkerToMainMessage): Promise<void> {
    if (message.type === 'remote-fleet.result') {
      this.resolveInvoke(message);
      return;
    }
    await this.handleHostRequest(message);
  }

  private resolveInvoke(message: RemoteFleetWorkerResponse): void {
    const pending = this.pending.get(message.requestId);
    if (!pending) {
      this.logWorkerRpc('invoke result', { requestId: message.requestId, status: 'orphaned' });
      return;
    }
    this.pending.delete(message.requestId);
    const durationMs = elapsedMsSince(pending.startedAtMs);
    if (message.ok) {
      this.logWorkerRpc('invoke result', {
        requestId: message.requestId,
        operationId: pending.operationId,
        status: 'succeeded',
        durationMs,
      });
      pending.resolve(message.response);
      return;
    }
    this.logWorkerRpc('invoke error', {
      requestId: message.requestId,
      operationId: pending.operationId,
      status: 'failed',
      durationMs,
      errorName: 'RemoteFleetWorkerFailure',
    });
    pending.reject(errorFromRemoteFleetWorker(message.error));
  }

  private async handleHostRequest(message: RemoteFleetHostRequest): Promise<void> {
    const startedAtMs = Date.now();
    this.logWorkerRpc('host request dispatch', {
      requestId: message.requestId,
      hostRequestType: message.type,
      status: 'dispatching',
    });
    try {
      const result = await this.dispatchHostRequest(message);
      this.worker.postMessage({ type: 'host.result', requestId: message.requestId, ok: true, result } satisfies RemoteFleetHostResponse);
      this.logWorkerRpc('host request result', {
        requestId: message.requestId,
        hostRequestType: message.type,
        status: 'succeeded',
        durationMs: elapsedMsSince(startedAtMs),
      });
    } catch (error) {
      this.worker.postMessage({ type: 'host.result', requestId: message.requestId, ok: false, error: serializeRemoteFleetWorkerError(error) } satisfies RemoteFleetHostResponse);
      this.logWorkerRpc('host request error', {
        requestId: message.requestId,
        hostRequestType: message.type,
        status: 'failed',
        durationMs: elapsedMsSince(startedAtMs),
        errorName: safeErrorName(error),
      });
    }
  }

  private async dispatchHostRequest(message: RemoteFleetHostRequest): Promise<unknown> {
    return dispatchRemoteFleetHostRequest(message, this.deps);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  private logWorkerRpc(event: string, fields: RemoteFleetWorkerLogFields): void {
    const logFields = {
      requestId: fields.requestId ?? 'none',
      operationId: fields.operationId ?? 'none',
      hostRequestType: fields.hostRequestType ?? 'none',
      status: fields.status,
      durationMs: fields.durationMs ?? 0,
      pendingCount: fields.pendingCount ?? this.pending.size,
      ...(fields.exitCode !== undefined ? { exitCode: fields.exitCode } : {}),
      ...(fields.errorName ? { errorName: fields.errorName } : {}),
    };
    if (fields.status === 'failed' || fields.status === 'errored') {
      this.deps.logger?.warn?.(`[remote-fleet:worker-client] ${event}`, logFields);
      return;
    }
    this.deps.logger?.debug?.(`[remote-fleet:worker-client] ${event}`, logFields);
  }
}

export async function dispatchRemoteFleetHostRequest(
  message: RemoteFleetHostRequest,
  deps: RemoteFleetHostRequestDispatchDeps,
): Promise<unknown> {
  switch (message.type) {
    case 'host.event.emit':
      deps.logger?.debug?.('[remote-fleet:worker-client] host event', {
        eventName: message.eventName,
      });
      return { success: true };
    case 'host.capability.replaceForEndpointScope':
      requireCapabilityRegistry(deps).replaceForRuntimeEndpointScope(message.scope, message.descriptors);
      return { success: true };
    case 'host.capability.pruneEndpointScope':
      requireCapabilityRegistry(deps).removeForRuntimeEndpointScope(message.scope);
      return { success: true };
    case 'host.runtimeAgent.dispatchCommand':
      return await dispatchRuntimeAgentCommandHostRequest(message.envelope, deps);
    case 'host.remoteFleetBootstrap.dispatchCommand':
      return await dispatchRemoteFleetBootstrapCommandHostRequest(message.envelope, deps);
    case 'host.remoteFleetConnectionProbe.dispatch':
      return await dispatchRemoteFleetConnectionProbeHostRequest(message.envelope, deps);
    case 'host.remoteFleetTerminal.issueTicket':
      return await dispatchTerminalIssueTicketHostRequest(message, deps);
    case 'host.remoteFleetTerminal.closeSession':
      return await dispatchTerminalCloseSessionHostRequest(message, deps);
    case 'host.secret.resolve':
      return await dispatchSecretResolveHostRequest(message, deps);
    case 'host.secret.write':
      return await dispatchSecretWriteHostRequest(message, deps);
    case 'host.secret.write.status':
      return await dispatchSecretWriteStatusHostRequest(message, deps);
  }
}

async function dispatchRuntimeAgentCommandHostRequest(
  envelope: RemoteFleetCommandDispatchEnvelope,
  deps: RemoteFleetHostRequestDispatchDeps,
): Promise<RemoteFleetRuntimeAgentDispatchResult> {
  if (!deps.runtimeAgentDispatcher) {
    return { resultType: 'unavailable', accepted: false };
  }
  return await deps.runtimeAgentDispatcher.dispatchCommand(envelope);
}

async function dispatchRemoteFleetBootstrapCommandHostRequest(
  envelope: RemoteFleetBootstrapCommandEnvelope,
  deps: RemoteFleetHostRequestDispatchDeps,
): Promise<RemoteFleetBootstrapCommandResult> {
  if (!deps.bootstrapDispatcher) {
    return createUnavailableBootstrapResult(envelope, 'Remote Fleet bootstrap dispatcher is unavailable.');
  }
  const result = await deps.bootstrapDispatcher.dispatchCommand(envelope);
  return normalizeBootstrapCommandResult(envelope, result);
}

async function dispatchRemoteFleetConnectionProbeHostRequest(
  envelope: RemoteFleetConnectionProbeEnvelope,
  deps: RemoteFleetHostRequestDispatchDeps,
): Promise<RemoteFleetConnectionProbeResult> {
  if (!deps.bootstrapDispatcher) {
    return createUnavailableConnectionProbeResult(envelope);
  }
  const result = await deps.bootstrapDispatcher.probeConnection(envelope);
  return isRemoteFleetConnectionProbeResult(result)
    ? result
    : createUnavailableConnectionProbeResult(envelope);
}

function normalizeBootstrapCommandResult(
  envelope: RemoteFleetBootstrapCommandEnvelope,
  result: unknown,
): RemoteFleetBootstrapCommandResult {
  if (!isRemoteFleetBootstrapCommandResult(result)) {
    return createUnavailableBootstrapResult(envelope, 'Remote Fleet bootstrap dispatcher returned an invalid result.');
  }

  if (result.resultType === 'completed') {
    return {
      resultType: 'completed',
      commandId: result.commandId,
      providerKind: result.providerKind,
      ...(isString(result.message) ? { message: result.message } : {}),
      ...(isString(result.outputSummary) ? { outputSummary: result.outputSummary } : {}),
      ...(isString(result.remoteResourceId) ? { remoteResourceId: result.remoteResourceId } : {}),
      ...(result.managedResources ? { managedResources: normalizeBootstrapManagedResources(result.managedResources) } : {}),
    };
  }

  return {
    resultType: 'failed',
    commandId: result.commandId,
    ...(isString(result.providerKind) ? { providerKind: result.providerKind } : {}),
    reason: result.reason,
    message: result.message,
  };
}

function normalizeBootstrapManagedResources(
  managedResources: NonNullable<Extract<RemoteFleetBootstrapCommandResult, { readonly resultType: 'completed' }>['managedResources']>,
): NonNullable<Extract<RemoteFleetBootstrapCommandResult, { readonly resultType: 'completed' }>['managedResources']> {
  return managedResources.map((resource) => ({
    providerKind: resource.providerKind,
    resourceKind: resource.resourceKind,
    remoteResourceId: resource.remoteResourceId,
    remoteRefs: resource.remoteRefs.map((remoteRef) => ({
      providerKind: remoteRef.providerKind,
      resourceKind: remoteRef.resourceKind,
      remoteResourceId: remoteRef.remoteResourceId,
      ...(isString(remoteRef.namespace) ? { namespace: remoteRef.namespace } : {}),
      ...(isString(remoteRef.name) ? { name: remoteRef.name } : {}),
    })),
    ownership: resource.ownership,
    cleanupPolicy: resource.cleanupPolicy,
    displayName: resource.displayName,
    ...(resource.labels ? { labels: resource.labels } : {}),
  }));
}

async function dispatchTerminalIssueTicketHostRequest(
  message: RemoteFleetTerminalIssueTicketHostRpcRequest,
  deps: RemoteFleetHostRequestDispatchDeps,
): Promise<RemoteFleetTerminalIssueTicketHostRpcResponse> {
  if (!deps.terminalHost) {
    return {
      type: 'host.remoteFleetTerminal.issueTicket.result',
      requestId: message.requestId,
      resultType: 'unavailable',
      message: 'Remote Fleet terminal host is unavailable.',
    };
  }
  const result = await deps.terminalHost.issueConnectionTicket(message.input);
  return { ...result, requestId: message.requestId };
}

async function dispatchTerminalCloseSessionHostRequest(
  message: RemoteFleetTerminalCloseSessionHostRpcRequest,
  deps: RemoteFleetHostRequestDispatchDeps,
): Promise<RemoteFleetTerminalCloseSessionHostRpcResponse> {
  if (!deps.terminalHost) {
    return {
      type: 'host.remoteFleetTerminal.closeSession.result',
      requestId: message.requestId,
      resultType: 'unavailable',
      message: 'Remote Fleet terminal host is unavailable.',
    };
  }
  const result = await deps.terminalHost.closeSession(message.input);
  return { ...result, requestId: message.requestId };
}

async function dispatchSecretResolveHostRequest(
  message: RemoteFleetSecretResolveHostRpcRequest,
  deps: RemoteFleetHostRequestDispatchDeps,
): Promise<RemoteFleetSecretResolveHostRpcResponse> {
  const validation = validateSecretResolveRequest(message);
  if (validation.resultType !== 'valid') {
    return {
      type: REMOTE_FLEET_SECRET_HOST_RPC_RESULT_TYPE,
      requestId: message.requestId,
      resultType: 'invalidRequest',
      validationReason: validation.reason,
    };
  }

  const policy = evaluateRemoteFleetSecretRefPolicy(validation.request.input.secretRef);
  if (policy.decision !== 'allowed') {
    return {
      type: REMOTE_FLEET_SECRET_HOST_RPC_RESULT_TYPE,
      requestId: validation.request.requestId,
      resultType: 'accessDenied',
      secretRef: validation.request.input.secretRef,
    };
  }

  if (!deps.secretResolver) {
    return {
      type: REMOTE_FLEET_SECRET_HOST_RPC_RESULT_TYPE,
      requestId: validation.request.requestId,
      resultType: 'unavailable',
    };
  }

  try {
    const result = await deps.secretResolver.resolveSecret(validation.request.input);
    return normalizeSecretResolveResponse(validation.request.requestId, result);
  } catch {
    throw new Error('RemoteFleet secret resolver failed while resolving a secret reference.');
  }
}

async function dispatchSecretWriteHostRequest(
  message: RemoteFleetSecretWriteHostRpcRequest,
  deps: RemoteFleetHostRequestDispatchDeps,
): Promise<RemoteFleetSecretWriteHostRpcResponse> {
  const validation = validateCredentialWriteRequest(message);
  if (validation.resultType !== 'valid') {
    return {
      type: REMOTE_FLEET_SECRET_WRITE_HOST_RPC_RESULT_TYPE,
      requestId: message.requestId,
      resultType: 'invalidRequest',
      message: validation.message,
    };
  }

  if (!deps.credentialWriter) {
    return {
      type: REMOTE_FLEET_SECRET_WRITE_HOST_RPC_RESULT_TYPE,
      requestId: validation.request.requestId,
      resultType: 'unavailable',
    };
  }

  try {
    const result = await deps.credentialWriter.writeCredential(validation.request.input);
    if (isSecretResolveResultRecord(result) && result.resultType === 'operationConflict') {
      return {
        type: REMOTE_FLEET_SECRET_WRITE_HOST_RPC_RESULT_TYPE,
        requestId: validation.request.requestId,
        resultType: 'invalidRequest',
        message: 'Remote Fleet credential write operation conflicts with an existing credential target.',
      };
    }
    return normalizeSecretWriteResponse(validation.request.requestId, result);
  } catch {
    return {
      type: REMOTE_FLEET_SECRET_WRITE_HOST_RPC_RESULT_TYPE,
      requestId: validation.request.requestId,
      resultType: 'unavailable',
    };
  }
}

async function dispatchSecretWriteStatusHostRequest(
  message: RemoteFleetSecretWriteStatusHostRpcRequest,
  deps: RemoteFleetHostRequestDispatchDeps,
): Promise<RemoteFleetSecretWriteStatusHostRpcResponse> {
  const validation = validateCredentialWriteStatusRequest(message);
  if (validation.resultType !== 'valid') {
    return {
      type: REMOTE_FLEET_SECRET_WRITE_STATUS_HOST_RPC_RESULT_TYPE,
      requestId: message.requestId,
      resultType: 'invalidRequest',
      message: validation.message,
    };
  }
  if (!deps.credentialWriter?.lookupWriteReceipt) {
    return {
      type: REMOTE_FLEET_SECRET_WRITE_STATUS_HOST_RPC_RESULT_TYPE,
      requestId: validation.request.requestId,
      resultType: 'unavailable',
    };
  }
  try {
    const result = await deps.credentialWriter.lookupWriteReceipt(validation.request.input);
    return normalizeSecretWriteStatusResponse(validation.request.requestId, result);
  } catch {
    return {
      type: REMOTE_FLEET_SECRET_WRITE_STATUS_HOST_RPC_RESULT_TYPE,
      requestId: validation.request.requestId,
      resultType: 'unavailable',
    };
  }
}

function normalizeSecretWriteStatusResponse(
  requestId: string,
  result: RemoteFleetSecretWriteStatusHostRpcResponse | Omit<RemoteFleetSecretWriteStatusHostRpcResponse, 'type' | 'requestId'>,
): RemoteFleetSecretWriteStatusHostRpcResponse {
  if (!isSecretResolveResultRecord(result)) {
    return invalidSecretWriteStatusResult(requestId);
  }
  if (result.resultType === 'completed') {
    const credentialRef = isSecretResolveResultRecord(result.credentialRef) ? result.credentialRef : {};
    if (!isNonEmptyString(result.credentialName) || !isRemoteFleetWritableCredentialName(result.credentialName) || credentialRef.kind !== 'secret-ref' || !isNonEmptyString(credentialRef.ref) || !isIsoTimestamp(result.writtenAt)) {
      return invalidSecretWriteStatusResult(requestId);
    }
    return {
      type: REMOTE_FLEET_SECRET_WRITE_STATUS_HOST_RPC_RESULT_TYPE,
      requestId,
      resultType: 'completed',
      credentialName: result.credentialName,
      credentialRef: { kind: 'secret-ref', ref: credentialRef.ref },
      writtenAt: result.writtenAt,
    };
  }
  if (result.resultType === 'notFound' || result.resultType === 'operationConflict' || result.resultType === 'unavailable') {
    return {
      type: REMOTE_FLEET_SECRET_WRITE_STATUS_HOST_RPC_RESULT_TYPE,
      requestId,
      resultType: result.resultType,
    };
  }
  return invalidSecretWriteStatusResult(requestId);
}

function invalidSecretWriteStatusResult(requestId: string): RemoteFleetSecretWriteStatusHostRpcResponse {
  return {
    type: REMOTE_FLEET_SECRET_WRITE_STATUS_HOST_RPC_RESULT_TYPE,
    requestId,
    resultType: 'invalidRequest',
    message: 'Remote Fleet credential write status returned an invalid result.',
  };
}

function normalizeSecretWriteResponse(
  requestId: string,
  result: RemoteFleetSecretWriteHostRpcResponse | RemoteFleetSecretWriteHostRpcResult,
): RemoteFleetSecretWriteHostRpcResponse {
  if (!isSecretResolveResultRecord(result)) {
    return invalidSecretWriteResult(requestId);
  }
  if (result.resultType === 'written') {
    const credentialRef = isSecretResolveResultRecord(result.credentialRef) ? result.credentialRef : {};
    if (!isNonEmptyString(result.credentialName) || !isRemoteFleetWritableCredentialName(result.credentialName) || credentialRef.kind !== 'secret-ref' || !isNonEmptyString(credentialRef.ref) || !isIsoTimestamp(result.writtenAt)) {
      return invalidSecretWriteResult(requestId);
    }
    return {
      type: REMOTE_FLEET_SECRET_WRITE_HOST_RPC_RESULT_TYPE,
      requestId,
      resultType: 'written',
      credentialName: result.credentialName,
      credentialRef: {
        kind: 'secret-ref',
        ref: credentialRef.ref,
      },
      writtenAt: result.writtenAt,
    };
  }
  if (result.resultType === 'invalidRequest') {
    return {
      type: REMOTE_FLEET_SECRET_WRITE_HOST_RPC_RESULT_TYPE,
      requestId,
      resultType: 'invalidRequest',
      message: isNonEmptyString(result.message) ? result.message : 'Remote Fleet credential write request is invalid.',
    };
  }
  if (result.resultType === 'unavailable') {
    return {
      type: REMOTE_FLEET_SECRET_WRITE_HOST_RPC_RESULT_TYPE,
      requestId,
      resultType: 'unavailable',
    };
  }
  return {
    type: REMOTE_FLEET_SECRET_WRITE_HOST_RPC_RESULT_TYPE,
    requestId,
    resultType: 'unavailable',
  };
}

function invalidSecretWriteResult(requestId: string): RemoteFleetSecretWriteHostRpcResponse {
  return {
    type: REMOTE_FLEET_SECRET_WRITE_HOST_RPC_RESULT_TYPE,
    requestId,
    resultType: 'invalidRequest',
    message: 'Remote Fleet credential writer returned an invalid result.',
  };
}

function normalizeSecretResolveResponse(
  requestId: string,
  result: RemoteFleetSecretResolveHostRpcResponse | RemoteFleetSecretResolveHostRpcResult,
): RemoteFleetSecretResolveHostRpcResponse {
  if (!isSecretResolveResultRecord(result)) {
    return invalidSecretResolveResult(requestId);
  }

  switch (result.resultType) {
    case 'resolved':
      if (!isNonEmptyString(result.secretRef) || !isString(result.plaintextSecretValue)) {
        return invalidSecretResolveResult(requestId);
      }
      return {
        type: REMOTE_FLEET_SECRET_HOST_RPC_RESULT_TYPE,
        requestId,
        resultType: 'resolved',
        secretRef: result.secretRef,
        plaintextSecretValue: result.plaintextSecretValue,
      };
    case 'notFound':
      if (!isNonEmptyString(result.secretRef)) {
        return invalidSecretResolveResult(requestId);
      }
      return {
        type: REMOTE_FLEET_SECRET_HOST_RPC_RESULT_TYPE,
        requestId,
        resultType: 'notFound',
        secretRef: result.secretRef,
      };
    case 'accessDenied':
      if (!isNonEmptyString(result.secretRef)) {
        return invalidSecretResolveResult(requestId);
      }
      return {
        type: REMOTE_FLEET_SECRET_HOST_RPC_RESULT_TYPE,
        requestId,
        resultType: 'accessDenied',
        secretRef: result.secretRef,
      };
    case 'unavailable':
      return {
        type: REMOTE_FLEET_SECRET_HOST_RPC_RESULT_TYPE,
        requestId,
        resultType: 'unavailable',
      };
    case 'invalidRequest':
      if (!isSecretResolveValidationFailureReason(result.validationReason)) {
        return invalidSecretResolveResult(requestId);
      }
      return {
        type: REMOTE_FLEET_SECRET_HOST_RPC_RESULT_TYPE,
        requestId,
        resultType: 'invalidRequest',
        validationReason: result.validationReason,
      };
    default:
      return unavailableSecretResolveResult(requestId);
  }
}

function isSecretResolveResultRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIsoTimestamp(value: unknown): value is string {
  return isNonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function isSecretResolveValidationFailureReason(
  value: unknown,
): value is RemoteFleetSecretResolveRequestValidationFailureReason {
  return (
    value === 'requestNotObject' ||
    value === 'unknownField' ||
    value === 'plaintextFieldNotAllowed' ||
    value === 'requestTypeInvalid' ||
    value === 'requestIdInvalid' ||
    value === 'inputNotObject' ||
    value === 'secretRefInvalid' ||
    value === 'purposeInvalid' ||
    value === 'commandExecutionIdInvalid' ||
    value === 'workerIdInvalid'
  );
}

function invalidSecretResolveResult(requestId: string): RemoteFleetSecretResolveHostRpcResponse {
  return {
    type: REMOTE_FLEET_SECRET_HOST_RPC_RESULT_TYPE,
    requestId,
    resultType: 'invalidRequest',
    validationReason: 'unknownField',
  };
}

function unavailableSecretResolveResult(requestId: string): RemoteFleetSecretResolveHostRpcResponse {
  return {
    type: REMOTE_FLEET_SECRET_HOST_RPC_RESULT_TYPE,
    requestId,
    resultType: 'unavailable',
  };
}

function requireCapabilityRegistry(deps: RemoteFleetHostRequestDispatchDeps): RemoteFleetCapabilityRegistryPort {
  if (!deps.capabilityRegistry) {
    throw new Error('RemoteFleet capability registry host port is required');
  }
  return deps.capabilityRegistry;
}

function elapsedMsSince(startedAtMs: number): number {
  return Date.now() - startedAtMs;
}

function safeErrorName(error: unknown): string {
  if (error instanceof Error && error.name) {
    return error.name;
  }
  return typeof error;
}
