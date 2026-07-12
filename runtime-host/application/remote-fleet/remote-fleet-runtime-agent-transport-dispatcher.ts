import { randomUUID } from 'node:crypto';
import type { RuntimeHostLogger } from '../../shared/logger';
import {
  REMOTE_FLEET_SECRET_RESOLVE_PURPOSE,
  type RemoteFleetSecretResolveRequestInput,
} from './remote-fleet-secret-host-rpc';
import {
  normalizeRuntimeAgentClientRequest,
  normalizeRuntimeAgentClientTarget,
  type RuntimeAgentAcceptCommandRequest,
  type RuntimeAgentClientCallResult,
  type RuntimeAgentClientResponse,
  type RuntimeAgentTransport,
  type RuntimeAgentTransportRequest,
  type RuntimeAgentTransportTarget,
} from './remote-fleet-agent-client';
import type { RemoteFleetCommandDispatchEnvelope } from './remote-fleet-command-dispatch';
import type {
  RemoteFleetRuntimeAgentDispatcherPort,
  RemoteFleetRuntimeAgentDispatchResult,
  RemoteFleetSecretResolverPort,
} from './remote-fleet-worker-client';

export const REMOTE_FLEET_RUNTIME_AGENT_DEFAULT_TIMEOUT_MS = 15_000;

export type RemoteFleetRuntimeAgentTargetUnavailableReason =
  | 'target-not-found'
  | 'credential-unavailable'
  | 'invalid-target'
  | 'invalid-request'
  | 'transport-unavailable';

export type RemoteFleetRuntimeAgentTargetResolveResult =
  | {
      readonly resultType: 'resolved';
      readonly target: RuntimeAgentTransportTarget;
    }
  | {
      readonly resultType: 'unavailable';
      readonly reason: RemoteFleetRuntimeAgentTargetUnavailableReason;
    };

export interface RemoteFleetRuntimeAgentTargetResolverPort {
  resolveTarget(envelope: RemoteFleetCommandDispatchEnvelope):
    | Promise<RemoteFleetRuntimeAgentTargetResolveResult>
    | RemoteFleetRuntimeAgentTargetResolveResult;
}

export interface RemoteFleetRuntimeAgentTransportDispatcherDeps {
  readonly transport: RuntimeAgentTransport;
  readonly targetResolver?: RemoteFleetRuntimeAgentTargetResolverPort;
  readonly secretResolver?: RemoteFleetSecretResolverPort;
  readonly clock?: { nowIso(): string };
  readonly createRequestId?: (envelope: RemoteFleetCommandDispatchEnvelope) => string;
  readonly logger?: Pick<RuntimeHostLogger, 'debug' | 'warn'>;
}

export function createRemoteFleetRuntimeAgentTransportDispatcher(
  deps: RemoteFleetRuntimeAgentTransportDispatcherDeps,
): RemoteFleetRuntimeAgentDispatcherPort {
  return {
    dispatchCommand: (envelope) => dispatchRuntimeAgentCommand(envelope, deps),
  };
}

async function dispatchRuntimeAgentCommand(
  envelope: RemoteFleetCommandDispatchEnvelope,
  deps: RemoteFleetRuntimeAgentTransportDispatcherDeps,
): Promise<RemoteFleetRuntimeAgentDispatchResult> {
  const targetResult = await resolveDispatchTarget(envelope, deps);
  if (targetResult.resultType === 'unavailable') {
    logUnavailable(deps, envelope, targetResult.reason);
    return unavailable();
  }

  const targetValidation = normalizeRuntimeAgentClientTarget(targetResult.target);
  if (targetValidation.resultType === 'invalid') {
    logUnavailable(deps, envelope, 'invalid-target', {
      field: targetValidation.field,
      reason: targetValidation.reason,
    });
    return unavailable();
  }

  const request = buildAcceptCommandRequest(envelope, deps);
  const requestValidation = normalizeRuntimeAgentClientRequest(request);
  if (requestValidation.resultType === 'invalid') {
    logUnavailable(deps, envelope, 'invalid-request', {
      field: requestValidation.field,
      reason: requestValidation.reason,
    });
    return unavailable();
  }

  try {
    const result = await deps.transport.request({ target: targetResult.target, request: requestValidation.value });
    if (result.resultType === 'failed') {
      logUnavailable(deps, envelope, 'transport-unavailable', { reason: result.reason });
      return unavailable();
    }

    if (isAcceptedCommandResponse(result.response, envelope, request.requestId)) {
      deps.logger?.debug?.('[remote-fleet:runtime-agent-dispatcher] command accepted', {
        commandId: envelope.commandId,
        commandName: envelope.commandName,
        agentId: envelope.agentId,
        nodeId: envelope.nodeId,
      });
      return { resultType: 'accepted', accepted: true };
    }

    logUnavailable(deps, envelope, 'transport-unavailable', {
      responseType: result.response.type,
      responseResultType: result.response.resultType,
    });
    return unavailable();
  } catch (error) {
    logUnavailable(deps, envelope, 'transport-unavailable', { errorName: safeErrorName(error) });
    return unavailable();
  }
}

async function resolveDispatchTarget(
  envelope: RemoteFleetCommandDispatchEnvelope,
  deps: RemoteFleetRuntimeAgentTransportDispatcherDeps,
): Promise<RemoteFleetRuntimeAgentTargetResolveResult> {
  if (deps.targetResolver) {
    try {
      return await deps.targetResolver.resolveTarget(envelope);
    } catch (error) {
      logUnavailable(deps, envelope, 'target-not-found', { errorName: safeErrorName(error) });
      return { resultType: 'unavailable', reason: 'target-not-found' };
    }
  }

  return await resolveDispatchTargetFromEnvelope(envelope, deps);
}

async function resolveDispatchTargetFromEnvelope(
  envelope: RemoteFleetCommandDispatchEnvelope,
  deps: RemoteFleetRuntimeAgentTransportDispatcherDeps,
): Promise<RemoteFleetRuntimeAgentTargetResolveResult> {
  if (!envelope.dispatchTarget) {
    return { resultType: 'unavailable', reason: 'target-not-found' };
  }
  if (!deps.secretResolver) {
    return { resultType: 'unavailable', reason: 'credential-unavailable' };
  }

  const secretResult = await deps.secretResolver.resolveSecret(buildCredentialResolveInput(envelope));
  if (secretResult.resultType !== 'resolved') {
    return { resultType: 'unavailable', reason: 'credential-unavailable' };
  }

  return {
    resultType: 'resolved',
    target: {
      endpointUrl: envelope.dispatchTarget.endpointUrl,
      credential: {
        kind: 'bearer-token',
        token: secretResult.plaintextSecretValue,
        credentialId: envelope.dispatchTarget.credentialRef.ref,
      },
      ...(envelope.dispatchTarget.timeoutMs === undefined ? {} : { timeoutMs: envelope.dispatchTarget.timeoutMs }),
    },
  };
}

function buildCredentialResolveInput(envelope: RemoteFleetCommandDispatchEnvelope): RemoteFleetSecretResolveRequestInput {
  return {
    secretRef: envelope.dispatchTarget!.credentialRef.ref,
    purpose: REMOTE_FLEET_SECRET_RESOLVE_PURPOSE,
    commandExecutionId: envelope.commandId,
  };
}

function buildAcceptCommandRequest(
  envelope: RemoteFleetCommandDispatchEnvelope,
  deps: RemoteFleetRuntimeAgentTransportDispatcherDeps,
): RuntimeAgentAcceptCommandRequest {
  const sentAt = deps.clock?.nowIso() ?? new Date().toISOString();
  return {
    type: 'runtime-agent.command.accept',
    requestId: deps.createRequestId?.(envelope) ?? `remote-fleet-command-${envelope.commandId}-${randomUUID()}`,
    agentId: envelope.agentId,
    sentAt,
    commandId: envelope.commandId,
    commandName: envelope.commandName,
    issuedAt: sentAt,
    idempotencyKey: envelope.idempotencyKey,
    payload: envelope.request,
  };
}

function isAcceptedCommandResponse(
  response: RuntimeAgentClientResponse,
  envelope: RemoteFleetCommandDispatchEnvelope,
  requestId: string,
): boolean {
  return (
    response.type === 'runtime-agent.command.accept.response' &&
    response.resultType === 'accepted' &&
    response.requestId === requestId &&
    response.agentId === envelope.agentId &&
    response.commandId === envelope.commandId
  );
}

function logUnavailable(
  deps: RemoteFleetRuntimeAgentTransportDispatcherDeps,
  envelope: RemoteFleetCommandDispatchEnvelope,
  reason: RemoteFleetRuntimeAgentTargetUnavailableReason,
  fields: Readonly<Record<string, unknown>> = {},
): void {
  deps.logger?.warn?.('[remote-fleet:runtime-agent-dispatcher] command unavailable', {
    commandId: envelope.commandId,
    commandName: envelope.commandName,
    agentId: envelope.agentId,
    nodeId: envelope.nodeId,
    reason,
    ...fields,
  });
}

export function createRemoteFleetHttpRuntimeAgentTransport(
  deps: { readonly httpClient: { request(url: string, init?: RequestInit): Promise<{ readonly ok: boolean; readonly status: number; json(): Promise<unknown>; text(): Promise<string> }> } },
): RuntimeAgentTransport {
  return {
    async request(input) {
      return await requestRuntimeAgentOverHttp(input, deps);
    },
  };
}

async function requestRuntimeAgentOverHttp(
  input: RuntimeAgentTransportRequest,
  deps: { readonly httpClient: { request(url: string, init?: RequestInit): Promise<{ readonly ok: boolean; readonly status: number; json(): Promise<unknown>; text(): Promise<string> }> } },
): Promise<RuntimeAgentClientCallResult> {
  const targetValidation = normalizeRuntimeAgentClientTarget(input.target);
  if (targetValidation.resultType === 'invalid') {
    return { resultType: 'failed', reason: 'invalid-request', message: targetValidation.message };
  }
  const requestValidation = normalizeRuntimeAgentClientRequest(input.request);
  if (requestValidation.resultType === 'invalid') {
    return { resultType: 'failed', reason: 'invalid-request', message: requestValidation.message };
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...buildCredentialHeaders(input.target.credential),
  };

  try {
    const response = await deps.httpClient.request(input.target.endpointUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestValidation.value),
      signal: AbortSignal.timeout(input.target.timeoutMs ?? REMOTE_FLEET_RUNTIME_AGENT_DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { resultType: 'failed', reason: response.status === 401 || response.status === 403 ? 'authentication-failed' : 'transport-unavailable', message: `RuntimeAgent transport returned HTTP ${response.status}.` };
    }

    const responseBody = await response.json();
    if (!isRuntimeAgentClientResponse(responseBody)) {
      return { resultType: 'failed', reason: 'invalid-response', message: 'RuntimeAgent transport returned an invalid response.' };
    }
    if (responseBody.resultType === 'rejected') {
      return {
        resultType: 'failed',
        reason: responseBody.reason === 'unauthorized' ? 'authentication-failed' : 'remote-rejected',
        message: responseBody.message,
        ...(responseBody.retryAfterMs === undefined ? {} : { retryAfterMs: responseBody.retryAfterMs }),
      };
    }

    return { resultType: 'delivered', response: responseBody };
  } catch (error) {
    return { resultType: 'failed', reason: error instanceof DOMException && error.name === 'TimeoutError' ? 'timeout' : 'transport-unavailable', message: 'RuntimeAgent transport request failed.' };
  }
}

function buildCredentialHeaders(credential: RuntimeAgentTransportTarget['credential']): Record<string, string> {
  switch (credential.kind) {
    case 'bearer-token':
      return { authorization: `Bearer ${credential.token}` };
    case 'shared-secret':
      return { 'x-runtime-agent-secret': credential.secret };
    case 'credential-reference':
      return { 'x-runtime-agent-credential-ref': credential.referenceId };
  }
}

function isRuntimeAgentClientResponse(value: unknown): value is RuntimeAgentClientResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.type === 'string'
    && typeof record.requestId === 'string'
    && typeof record.resultType === 'string';
}

function unavailable(): RemoteFleetRuntimeAgentDispatchResult {
  return { resultType: 'unavailable', accepted: false };
}

function safeErrorName(error: unknown): string {
  if (error instanceof Error && error.name) {
    return error.name;
  }
  return typeof error;
}
