import { hasExactKeys, isRecord } from '../runtime-host-delivery/transport/client';
import { isEndpoint as isRuntimeEndpoint, sameSessionIdentity as sameIdentity, type SessionIdentity } from '../runtime-host-delivery/transport/sessions/session-contract';
import type { SessionAbortRequest } from '../runtime-host-delivery/transport/sessions/abort';
import type { SessionModelSelectionRequest } from '../runtime-host-delivery/transport/sessions/model-selection';
import { decodeSessionPermissionRequest, type SessionPermissionOperationId, type SessionPermissionRequest } from '../runtime-host-delivery/transport/sessions/permission';
import { isSessionTraceEnabled, logSessionTrace, summarizeIdentifier } from '../runtime-host-delivery/transport/sessions/trace';
import { hasAllowedKeys, isIdentifier, isSessionIdentity, summarizeString } from './request-validation';

function sameEndpoint(left: SessionIdentity['endpoint'], right: SessionIdentity['endpoint']): boolean {
  return left.kind === right.kind
    && left.runtimeAdapterId === right.runtimeAdapterId
    && left.runtimeInstanceId === right.runtimeInstanceId;
}

export function adaptSessionCreateRequest(body: Record<string, unknown>): Record<string, unknown> {
  if (!hasExactKeys(body, ['id', 'operationId', 'scope', 'target', 'input'])
    || body.id !== 'session.prompt'
    || body.operationId !== 'sessions.create'
    || !isRecord(body.scope)
    || !hasExactKeys(body.scope, ['kind', 'endpoint', 'agentId'])
    || body.scope.kind !== 'agent'
    || !isRuntimeEndpoint(body.scope.endpoint)
    || !isIdentifier(body.scope.agentId)
    || !isRecord(body.target)
    || !hasExactKeys(body.target, ['kind', 'agentId'])
    || body.target.kind !== 'agent'
    || !isIdentifier(body.target.agentId)
    || body.target.agentId !== body.scope.agentId
    || !isRecord(body.input)
    || !hasAllowedKeys(body.input, ['endpoint', 'agentId'], ['endpointSessionId'])
    || !isRuntimeEndpoint(body.input.endpoint)
    || !sameEndpoint(body.input.endpoint, body.scope.endpoint)
    || body.input.agentId !== body.scope.agentId
    || (body.input.endpointSessionId !== undefined && !isIdentifier(body.input.endpointSessionId))) {
    throw new Error('Session create request is invalid');
  }
  return {
    id: 'session.prompt',
    operationId: 'sessions.create',
    scope: {
      kind: 'agent',
      endpoint: body.scope.endpoint,
      agentId: body.scope.agentId,
    },
    target: { kind: 'agent', agentId: body.target.agentId },
    input: {
      endpoint: body.input.endpoint,
      agentId: body.input.agentId,
      ...(body.input.endpointSessionId === undefined ? {} : { endpointSessionId: body.input.endpointSessionId }),
    },
  };
}

export function adaptSessionDeleteRequest(body: Record<string, unknown>): Record<string, unknown> {
  if (!hasExactKeys(body, ['id', 'operationId', 'scope', 'target', 'input'])
    || body.id !== 'session.management'
    || body.operationId !== 'sessions.delete'
    || !isRecord(body.scope)
    || !hasExactKeys(body.scope, ['kind', 'identity'])
    || body.scope.kind !== 'session'
    || !isSessionIdentity(body.scope.identity)
    || !isRecord(body.target)
    || !hasExactKeys(body.target, ['kind', 'identity'])
    || body.target.kind !== 'session'
    || !isSessionIdentity(body.target.identity)
    || !sameIdentity(body.scope.identity, body.target.identity)
    || !isRecord(body.input)
    || !hasAllowedKeys(body.input, ['sessionIdentity'], ['sessionKey'])
    || !isSessionIdentity(body.input.sessionIdentity)
    || !sameIdentity(body.scope.identity, body.input.sessionIdentity)
    || (body.input.sessionKey !== undefined && body.input.sessionKey !== body.scope.identity.sessionKey)) {
    throw new Error('Session delete request is invalid');
  }
  return {
    id: 'session.management',
    operationId: 'sessions.delete',
    scope: { kind: 'session', identity: body.scope.identity },
    target: { kind: 'session', identity: body.target.identity },
    input: { sessionIdentity: body.input.sessionIdentity },
  };
}

export function adaptSessionRenameRequest(body: Record<string, unknown>): Record<string, unknown> {
  if (!hasExactKeys(body, ['id', 'operationId', 'scope', 'target', 'input'])
    || body.id !== 'session.management'
    || body.operationId !== 'sessions.rename'
    || !isRecord(body.scope)
    || !hasExactKeys(body.scope, ['kind', 'identity'])
    || body.scope.kind !== 'session'
    || !isSessionIdentity(body.scope.identity)
    || !isRecord(body.target)
    || !hasExactKeys(body.target, ['kind', 'identity'])
    || body.target.kind !== 'session'
    || !isSessionIdentity(body.target.identity)
    || !sameIdentity(body.scope.identity, body.target.identity)
    || !isRecord(body.input)
    || !hasAllowedKeys(body.input, ['sessionIdentity', 'label'], ['sessionKey'])
    || !isSessionIdentity(body.input.sessionIdentity)
    || !sameIdentity(body.scope.identity, body.input.sessionIdentity)
    || (body.input.sessionKey !== undefined && body.input.sessionKey !== body.scope.identity.sessionKey)
    || typeof body.input.label !== 'string'
    || body.input.label.trim().length === 0) {
    throw new Error('Session rename request is invalid');
  }
  return {
    id: 'session.management',
    operationId: 'sessions.rename',
    scope: { kind: 'session', identity: body.scope.identity },
    target: { kind: 'session', identity: body.target.identity },
    input: { sessionIdentity: body.input.sessionIdentity, label: body.input.label },
  };
}

export function adaptSessionPermissionRequest(
  body: Record<string, unknown>,
  operationId: SessionPermissionOperationId,
  traceId?: string | null,
): SessionPermissionRequest {
  const request = decodeSessionPermissionRequest(body);
  if (!request || request.operationId !== operationId) {
    logSessionTrace('electron.permission.route.invalid', traceId, () => ({ operationId }));
    throw new Error('Session permission request is invalid');
  }
  if (isSessionTraceEnabled()) logSessionTrace('electron.permission.route.adapted', traceId, {
    operationId,
    adapter: request.scope.identity.endpoint.runtimeAdapterId,
    instance: request.scope.identity.endpoint.runtimeInstanceId,
    sessionKey: summarizeIdentifier(request.input.sessionKey),
    permissionMode: request.operationId === 'sessions.permission.set' ? request.input.permissionMode : null,
  });
  return request;
}

export function adaptSessionListRequest(body: Record<string, unknown>): Record<string, unknown> {
  if (!hasExactKeys(body, ['id', 'operationId', 'scope', 'target', 'input'])
    || body.id !== 'session.management'
    || body.operationId !== 'sessions.list'
    || !isRecord(body.scope)
    || !hasExactKeys(body.scope, ['kind', 'endpoint'])
    || body.scope.kind !== 'runtime-instance'
    || !isRuntimeEndpoint(body.scope.endpoint)
    || !isRecord(body.target)
    || !hasExactKeys(body.target, ['kind'])
    || body.target.kind !== 'runtime-endpoint'
    || !isRecord(body.input)
    || !hasExactKeys(body.input, ['endpoint'])
    || !isRuntimeEndpoint(body.input.endpoint)
    || !sameEndpoint(body.scope.endpoint, body.input.endpoint)) {
    throw new Error('Session list request is invalid');
  }
  return {
    id: 'session.management',
    operationId: 'sessions.list',
    scope: { kind: 'runtime-instance', endpoint: body.scope.endpoint },
    target: { kind: 'runtime-endpoint' },
    input: { endpoint: body.input.endpoint },
  };
}

export function adaptSessionAbortRequest(body: Record<string, unknown>, traceId?: string | null): SessionAbortRequest {
  if (!hasExactKeys(body, ['id', 'operationId', 'scope', 'target', 'input'])
    || (body.id !== 'session.prompt' && body.id !== 'session.abort')
    || body.operationId !== 'sessions.abort'
    || !isRecord(body.scope)
    || !hasExactKeys(body.scope, ['kind', 'identity'])
    || body.scope.kind !== 'session'
    || !isSessionIdentity(body.scope.identity)
    || !isRecord(body.target)
    || !hasExactKeys(body.target, ['kind', 'identity'])
    || body.target.kind !== 'session'
    || !isSessionIdentity(body.target.identity)
    || !sameIdentity(body.scope.identity, body.target.identity)
    || !isRecord(body.input)
    || !hasAllowedKeys(body.input, ['sessionKey', 'sessionIdentity'], ['endpointSessionId', 'runId', 'approvalIds'])
    || !isSessionIdentity(body.input.sessionIdentity)
    || !sameIdentity(body.scope.identity, body.input.sessionIdentity)
    || body.input.sessionKey !== body.scope.identity.sessionKey
    || (body.input.endpointSessionId !== undefined && !isIdentifier(body.input.endpointSessionId))
    || (body.input.runId !== undefined && !isIdentifier(body.input.runId))
    || (body.input.approvalIds !== undefined
      && (!Array.isArray(body.input.approvalIds)
        || body.input.approvalIds.some((approvalId) => !isIdentifier(approvalId))))
) {
    logSessionTrace('electron.abort.route.invalid', traceId, () => {
      const input = isRecord(body.input) ? body.input : null;
      return {
        reason: 'request-validation',
        sessionKey: summarizeString(input?.sessionKey),
        endpointSessionId: summarizeString(input?.endpointSessionId),
        runId: summarizeString(input?.runId),
        approvalIdsCount: Array.isArray(input?.approvalIds) ? input.approvalIds.length : null,
        emptyApprovalIds: Array.isArray(input?.approvalIds) && input.approvalIds.length === 0,
      };
    });
    throw new Error('Session abort request is invalid');
  }
  if (isSessionTraceEnabled()) logSessionTrace('electron.abort.route.adapted', traceId, {
    adapter: body.scope.identity.endpoint.runtimeAdapterId,
    sessionKey: summarizeString(body.input.sessionKey),
    endpointSessionId: summarizeString(body.input.endpointSessionId),
    runId: summarizeString(body.input.runId),
    approvalIdsCount: Array.isArray(body.input.approvalIds) ? body.input.approvalIds.length : null,
    emptyApprovalIds: Array.isArray(body.input.approvalIds) && body.input.approvalIds.length === 0,
  });
  return {
    id: 'session.abort',
    operationId: 'sessions.abort',
    scope: { kind: 'session', identity: body.scope.identity },
    target: { kind: 'session', identity: body.scope.identity },
    input: {
      identity: body.scope.identity,
      ...(body.input.endpointSessionId === undefined ? {} : { endpointSessionId: body.input.endpointSessionId as string }),
      ...(body.input.runId === undefined ? {} : { runId: body.input.runId as string }),
      ...(body.input.approvalIds === undefined || (body.input.approvalIds as string[]).length === 0
        ? {} : { approvalIds: body.input.approvalIds as string[] }),
    },
  };
}

export function adaptSessionModelSelectionRequest(body: Record<string, unknown>, traceId?: string | null): SessionModelSelectionRequest {
  if (!hasExactKeys(body, ['id', 'operationId', 'scope', 'target', 'input'])
    || body.id !== 'session.modelSelection'
    || body.operationId !== 'sessions.patchModel'
    || !isRecord(body.scope)
    || !hasExactKeys(body.scope, ['kind', 'identity'])
    || body.scope.kind !== 'session'
    || !isSessionIdentity(body.scope.identity)
    || !isRecord(body.target)
    || !hasExactKeys(body.target, ['kind', 'identity', 'modelSelectionId'])
    || body.target.kind !== 'model-selection'
    || !isSessionIdentity(body.target.identity)
    || !sameIdentity(body.scope.identity, body.target.identity)
    || !isIdentifier(body.target.modelSelectionId)
    || !isRecord(body.input)
    || !hasExactKeys(body.input, body.input.endpointSessionId === undefined
      ? ['sessionKey', 'sessionIdentity', 'modelSelectionId']
      : ['sessionKey', 'endpointSessionId', 'sessionIdentity', 'modelSelectionId'])
    || !isSessionIdentity(body.input.sessionIdentity)
    || !sameIdentity(body.scope.identity, body.input.sessionIdentity)
    || !isIdentifier(body.input.sessionKey)
    || body.input.sessionKey !== body.scope.identity.sessionKey
    || !isIdentifier(body.input.modelSelectionId)
    || body.input.modelSelectionId !== body.target.modelSelectionId
    || (body.input.endpointSessionId !== undefined && !isIdentifier(body.input.endpointSessionId))) {
    logSessionTrace('electron.model-selection.route.invalid', traceId, () => ({
      reason: explainSessionModelSelectionInvalid(body),
      envelope: summarizeSessionModelSelectionBody(body),
    }));
    throw new Error('Session model selection request is invalid');
  }
  const endpoint = body.scope.identity.endpoint;
  const sessionKey = body.scope.identity.sessionKey;
  const endpointSessionId = body.input.endpointSessionId;
  const modelSelectionId = body.input.modelSelectionId;
  logSessionTrace('electron.model-selection.route.adapted', traceId, () => ({
    adapter: endpoint.runtimeAdapterId,
    instance: endpoint.runtimeInstanceId,
    sessionKey: summarizeIdentifier(sessionKey),
    endpointSessionId: summarizeIdentifier(endpointSessionId),
    modelSelectionId: summarizeIdentifier(modelSelectionId),
  }));
  return {
    id: 'session.modelSelection',
    operationId: 'sessions.patchModel',
    scope: { kind: 'session', endpoint, sessionKey },
    target: { kind: 'model-selection' },
    input: {
      endpoint,
      sessionKey,
      ...(body.input.endpointSessionId === undefined ? {} : { endpointSessionId: body.input.endpointSessionId as string }),
      modelSelectionId: (body.input.modelSelectionId as string).trim(),
    },
  };
}

function explainSessionModelSelectionInvalid(body: Record<string, unknown>): string {
  if (!hasExactKeys(body, ['id', 'operationId', 'scope', 'target', 'input'])) return 'body-keys';
  if (body.id !== 'session.modelSelection') return 'capability-id';
  if (body.operationId !== 'sessions.patchModel') return 'operation-id';
  if (!isRecord(body.scope)) return 'scope-shape';
  if (!hasExactKeys(body.scope, ['kind', 'identity'])) return 'scope-keys';
  if (body.scope.kind !== 'session') return 'scope-kind';
  if (!isSessionIdentity(body.scope.identity)) return 'scope-identity';
  if (!isRecord(body.target)) return 'target-shape';
  if (!hasExactKeys(body.target, ['kind', 'identity', 'modelSelectionId'])) return 'target-keys';
  if (body.target.kind !== 'model-selection') return 'target-kind';
  if (!isSessionIdentity(body.target.identity)) return 'target-identity';
  if (!sameIdentity(body.scope.identity, body.target.identity)) return 'target-identity-mismatch';
  if (!isIdentifier(body.target.modelSelectionId)) return 'target-model-selection-id';
  if (!isRecord(body.input)) return 'input-shape';
  if (!hasExactKeys(body.input, body.input.endpointSessionId === undefined
    ? ['sessionKey', 'sessionIdentity', 'modelSelectionId']
    : ['sessionKey', 'endpointSessionId', 'sessionIdentity', 'modelSelectionId'])) return 'input-keys';
  if (!isSessionIdentity(body.input.sessionIdentity)) return 'input-session-identity';
  if (!sameIdentity(body.scope.identity, body.input.sessionIdentity)) return 'input-identity-mismatch';
  if (!isIdentifier(body.input.sessionKey)) return 'input-session-key';
  if (body.input.sessionKey !== body.scope.identity.sessionKey) return 'input-session-key-mismatch';
  if (!isIdentifier(body.input.modelSelectionId)) return 'input-model-selection-id';
  if (body.input.modelSelectionId !== body.target.modelSelectionId) return 'model-selection-id-mismatch';
  if (body.input.endpointSessionId !== undefined && !isIdentifier(body.input.endpointSessionId)) return 'endpoint-session-id';
  return 'unknown';
}

function summarizeSessionModelSelectionBody(body: Record<string, unknown>) {
  const scope = isRecord(body.scope) ? body.scope : null;
  const target = isRecord(body.target) ? body.target : null;
  const input = isRecord(body.input) ? body.input : null;
  return {
    bodyKeyCount: Object.keys(body).length,
    scopeKeyCount: scope ? Object.keys(scope).length : null,
    targetKeyCount: target ? Object.keys(target).length : null,
    inputKeyCount: input ? Object.keys(input).length : null,
    scopeSessionKey: summarizeString(isRecord(scope?.identity) ? scope.identity.sessionKey : null),
    targetSessionKey: summarizeString(isRecord(target?.identity) ? target.identity.sessionKey : null),
    inputIdentitySessionKey: summarizeString(isRecord(input?.sessionIdentity) ? input.sessionIdentity.sessionKey : null),
    inputSessionKey: summarizeString(input?.sessionKey),
    endpointSessionId: summarizeString(input?.endpointSessionId),
    targetModelSelectionId: summarizeString(target?.modelSelectionId),
    inputModelSelectionId: summarizeString(input?.modelSelectionId),
  };
}
