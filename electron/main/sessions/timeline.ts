import { hasExactKeys, isRecord, isSafeNonNegativeInteger } from '../runtime-host-delivery/transport/client';
import type { LoopbackJsonResponse as PublicTransportResponse } from '../runtime-host-delivery/transport/client';
import type { RuntimeHostTransports } from '../runtime-host-delivery/transport/host-api-transports';
import type { SessionContentLoadRequest } from '../runtime-host-delivery/transport/sessions/content';
import { isSessionInputIds, sameSessionIdentity as sameIdentity } from '../runtime-host-delivery/transport/sessions/session-contract';
import { isSessionTraceEnabled, logSessionTrace, summarizeIdentifier } from '../runtime-host-delivery/transport/sessions/trace';
import { hasAllowedKeys, isIdentifier, isSessionIdentity, summarizeString } from './request-validation';

type SessionTimelineDeps = Readonly<{
  runtimeHostTransports: Pick<RuntimeHostTransports, 'sessionTimelineTransport' | 'sessionContentTransport'>;
}>;

const MAX_CONTENT_REF_BYTES = 512;

export async function dispatchSessionTimeline(
  deps: SessionTimelineDeps,
  request: Record<string, unknown>,
  operation: 'load' | 'window',
  traceId?: string | null,
): Promise<PublicTransportResponse> {
  const identity = isRecord(request.scope) && isSessionIdentity(request.scope.identity)
    ? request.scope.identity
    : undefined;
  if (!identity) throw new Error('Session timeline request is invalid');
  switch (identity.endpoint.runtimeAdapterId) {
    case 'openclaw':
    case 'matcha-agent':
      return traceId === undefined
        ? await deps.runtimeHostTransports.sessionTimelineTransport[operation](request)
        : await deps.runtimeHostTransports.sessionTimelineTransport[operation](request, traceId);
  }
}

export async function dispatchSessionContent(
  deps: SessionTimelineDeps,
  request: SessionContentLoadRequest,
  traceId?: string | null,
): Promise<PublicTransportResponse> {
  return traceId === undefined
    ? await deps.runtimeHostTransports.sessionContentTransport.load(request)
    : await deps.runtimeHostTransports.sessionContentTransport.load(request, traceId);
}

export function adaptSessionTimelineRequest(
  body: Record<string, unknown>,
  operationId: 'sessions.load' | 'sessions.window',
  traceId?: string | null,
): Record<string, unknown> {
  const allowedIds = operationId === 'sessions.load'
    ? ['session.prompt', 'session.management']
    : ['session.management'];
  if (!hasExactKeys(body, ['id', 'operationId', 'scope', 'target', 'input'])
    || !allowedIds.includes(body.id as string)
    || body.operationId !== operationId
    || !isRecord(body.scope)
    || !hasExactKeys(body.scope, ['kind', 'identity'])
    || body.scope.kind !== 'session'
    || !isSessionIdentity(body.scope.identity)
    || !isRecord(body.target)
    || !hasExactKeys(body.target, ['kind', 'identity'])
    || body.target.kind !== 'session'
    || !isSessionIdentity(body.target.identity)
    || !sameIdentity(body.scope.identity, body.target.identity)
    || !isRecord(body.input)) {
    logSessionTrace('electron.timeline.route.invalid', traceId, () => ({
      operationId,
      reason: 'envelope',
      envelope: summarizeTimelineBody(body),
    }));
    throw new Error('Session timeline request is invalid');
  }

  const inputKeys = operationId === 'sessions.load'
    ? ['sessionKey', 'sessionIdentity', 'endpointSessionId', 'limit', 'inputIds']
    : ['sessionKey', 'sessionIdentity', 'endpointSessionId', 'mode', 'limit', 'offset', 'includeCanonical', 'inputIds'];
  if (!hasAllowedKeys(body.input, ['sessionKey', 'sessionIdentity'], inputKeys.slice(2))
    || !isSessionIdentity(body.input.sessionIdentity)
    || !sameIdentity(body.scope.identity, body.input.sessionIdentity)
    || body.input.sessionKey !== body.scope.identity.sessionKey
    || (body.input.endpointSessionId !== undefined && !isIdentifier(body.input.endpointSessionId))
    || (Object.hasOwn(body.input, 'inputIds') && (!isSessionInputIds(body.input.inputIds) || body.input.inputIds.length === 0))
    || (body.input.limit !== undefined && !isTimelineLimit(body.input.limit))) {
    logSessionTrace('electron.timeline.route.invalid', traceId, () => ({
      operationId,
      reason: 'input',
      envelope: summarizeTimelineBody(body),
    }));
    throw new Error('Session timeline request is invalid');
  }
  if (operationId === 'sessions.load') {
    if (body.input.mode !== undefined || body.input.offset !== undefined || body.input.includeCanonical !== undefined) {
      logSessionTrace('electron.timeline.route.invalid', traceId, () => ({
        operationId,
        reason: 'load-window-fields',
        envelope: summarizeTimelineBody(body),
      }));
      throw new Error('Session timeline request is invalid');
    }
    const request = {
      id: 'session.management',
      operationId,
      scope: { kind: 'session', identity: body.scope.identity },
      target: { kind: 'session', identity: body.target.identity },
      input: {
        sessionKey: body.input.sessionKey,
        sessionIdentity: body.input.sessionIdentity,
        ...(body.input.endpointSessionId === undefined ? {} : { endpointSessionId: body.input.endpointSessionId }),
        ...(body.input.limit === undefined ? {} : { limit: body.input.limit }),
        ...(body.input.inputIds === undefined ? {} : { inputIds: body.input.inputIds }),
      },
    };
    if (isSessionTraceEnabled()) logSessionTrace('electron.timeline.route.adapted', traceId, {
      operationId,
      adapter: body.scope.identity.endpoint.runtimeAdapterId,
      instance: body.scope.identity.endpoint.runtimeInstanceId,
      sessionKey: summarizeIdentifier(body.input.sessionKey as string),
      endpointSessionId: summarizeIdentifier(body.input.endpointSessionId as string | undefined),
      limit: body.input.limit ?? null,
    });
    return request;
  }

  if (body.input.includeCanonical !== undefined && typeof body.input.includeCanonical !== 'boolean') {
    logSessionTrace('electron.timeline.route.invalid', traceId, () => ({
      operationId,
      reason: 'include-canonical',
      envelope: summarizeTimelineBody(body),
    }));
    throw new Error('Session timeline request is invalid');
  }
  if (body.input.mode !== 'latest' && body.input.mode !== 'older' && body.input.mode !== 'newer') {
    logSessionTrace('electron.timeline.route.invalid', traceId, () => ({
      operationId,
      reason: 'mode',
      envelope: summarizeTimelineBody(body),
    }));
    throw new Error('Session timeline request is invalid');
  }
  if (body.input.mode === 'latest' && body.input.offset !== undefined) {
    logSessionTrace('electron.timeline.route.invalid', traceId, () => ({
      operationId,
      reason: 'latest-offset',
      envelope: summarizeTimelineBody(body),
    }));
    throw new Error('Session timeline request is invalid');
  }
  if (body.input.offset !== undefined && !isSafeNonNegativeInteger(body.input.offset)) {
    logSessionTrace('electron.timeline.route.invalid', traceId, () => ({
      operationId,
      reason: 'offset',
      envelope: summarizeTimelineBody(body),
    }));
    throw new Error('Session timeline request is invalid');
  }
  const request = {
    id: 'session.management',
    operationId,
    scope: { kind: 'session', identity: body.scope.identity },
    target: { kind: 'session', identity: body.target.identity },
    input: {
      sessionKey: body.input.sessionKey,
      sessionIdentity: body.input.sessionIdentity,
      ...(body.input.endpointSessionId === undefined ? {} : { endpointSessionId: body.input.endpointSessionId }),
      mode: body.input.mode,
      ...(body.input.limit === undefined ? {} : { limit: body.input.limit }),
      ...(body.input.offset === undefined ? {} : { offset: body.input.offset }),
      ...(body.input.includeCanonical === undefined ? {} : { includeCanonical: body.input.includeCanonical }),
      ...(body.input.inputIds === undefined ? {} : { inputIds: body.input.inputIds }),
    },
  };
  if (isSessionTraceEnabled()) logSessionTrace('electron.timeline.route.adapted', traceId, {
    operationId,
    adapter: body.scope.identity.endpoint.runtimeAdapterId,
    instance: body.scope.identity.endpoint.runtimeInstanceId,
    sessionKey: summarizeIdentifier(body.input.sessionKey as string),
    endpointSessionId: summarizeIdentifier(body.input.endpointSessionId as string | undefined),
    mode: body.input.mode,
    limit: body.input.limit ?? null,
    offset: body.input.offset ?? null,
    includeCanonical: body.input.includeCanonical ?? null,
  });
  return request;
}

export function adaptSessionContentLoadRequest(
  body: Record<string, unknown>,
  traceId?: string | null,
): SessionContentLoadRequest {
  if (!hasExactKeys(body, ['id', 'operationId', 'scope', 'target', 'input'])
    || body.id !== 'session.management'
    || body.operationId !== 'sessions.content.load'
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
    || !hasAllowedKeys(body.input, ['sessionKey', 'sessionIdentity', 'contentRef', 'offset'], ['endpointSessionId', 'limit'])
    || !isSessionIdentity(body.input.sessionIdentity)
    || !sameIdentity(body.scope.identity, body.input.sessionIdentity)
    || body.input.sessionKey !== body.scope.identity.sessionKey
    || !isIdentifier(body.input.contentRef, MAX_CONTENT_REF_BYTES)
    || !isSafeNonNegativeInteger(body.input.offset)
    || (body.input.endpointSessionId !== undefined && !isIdentifier(body.input.endpointSessionId))
    || (body.input.limit !== undefined && !isContentLimit(body.input.limit))) {
    logSessionTrace('electron.content.route.invalid', traceId, () => ({ envelope: summarizeTimelineBody(body) }));
    throw new Error('Session content request is invalid');
  }
  const request = {
    id: 'session.management',
    operationId: 'sessions.content.load',
    scope: { kind: 'session', identity: body.scope.identity },
    target: { kind: 'session', identity: body.target.identity },
    input: {
      sessionKey: body.input.sessionKey,
      sessionIdentity: body.input.sessionIdentity,
      ...(body.input.endpointSessionId === undefined ? {} : { endpointSessionId: body.input.endpointSessionId }),
      contentRef: body.input.contentRef,
      offset: body.input.offset,
      ...(body.input.limit === undefined ? {} : { limit: body.input.limit }),
    },
  } satisfies SessionContentLoadRequest;
  if (isSessionTraceEnabled()) logSessionTrace('electron.content.route.adapted', traceId, {
    adapter: body.scope.identity.endpoint.runtimeAdapterId,
    instance: body.scope.identity.endpoint.runtimeInstanceId,
    sessionKey: summarizeIdentifier(body.input.sessionKey as string),
    endpointSessionId: summarizeIdentifier(body.input.endpointSessionId as string | undefined),
    contentRef: summarizeIdentifier(body.input.contentRef as string),
    offset: body.input.offset,
    limit: body.input.limit ?? null,
  });
  return request;
}

function summarizeTimelineBody(body: Record<string, unknown>) {
  const scope = isRecord(body.scope) ? body.scope : null;
  const target = isRecord(body.target) ? body.target : null;
  const input = isRecord(body.input) ? body.input : null;
  return {
    bodyKeys: Object.keys(body).sort(),
    id: typeof body.id === 'string' ? body.id : null,
    operationId: typeof body.operationId === 'string' ? body.operationId : null,
    scopeKind: typeof scope?.kind === 'string' ? scope.kind : null,
    scopeIdentity: summarizeIdentityShape(scope?.identity),
    targetKind: typeof target?.kind === 'string' ? target.kind : null,
    targetIdentity: summarizeIdentityShape(target?.identity),
    inputKeys: input ? Object.keys(input).sort() : null,
    inputSessionKey: summarizeString(input?.sessionKey),
    inputSessionIdentity: summarizeIdentityShape(input?.sessionIdentity),
    endpointSessionId: summarizeString(input?.endpointSessionId),
    mode: typeof input?.mode === 'string' ? input.mode : null,
    limitType: input?.limit === undefined ? null : typeof input.limit,
    offsetType: input?.offset === undefined ? null : typeof input.offset,
    includeCanonicalType: input?.includeCanonical === undefined ? null : typeof input.includeCanonical,
  };
}

function summarizeIdentityShape(value: unknown) {
  if (!isRecord(value)) return null;
  return {
    keys: Object.keys(value).sort(),
    endpoint: summarizeEndpointShape(value.endpoint),
    agentId: summarizeString(value.agentId),
    sessionKey: summarizeString(value.sessionKey),
  };
}

function summarizeEndpointShape(value: unknown) {
  if (!isRecord(value)) return null;
  return {
    keys: Object.keys(value).sort(),
    kind: typeof value.kind === 'string' ? value.kind : null,
    runtimeAdapterId: typeof value.runtimeAdapterId === 'string' ? value.runtimeAdapterId : null,
    runtimeInstanceId: typeof value.runtimeInstanceId === 'string' ? value.runtimeInstanceId : null,
  };
}

function isTimelineLimit(value: unknown): value is number {
  return isSafeNonNegativeInteger(value) && value <= 200;
}

function isContentLimit(value: unknown): value is number {
  return isSafeNonNegativeInteger(value) && value > 0 && value <= 64 * 1024;
}
