import { isRecord } from '../runtime-host-delivery/transport/client';
import type { LoopbackJsonResponse as PublicTransportResponse } from '../runtime-host-delivery/transport/client';
import type { RuntimeHostTransports } from '../runtime-host-delivery/transport/host-api-transports';
import { isSessionThinkingRequest } from '../../../src/types/session-thinking';
import type { SessionPermissionOperationId, SessionPermissionRequest } from '../runtime-host-delivery/transport/sessions/permission';
import { logSessionTrace } from '../runtime-host-delivery/transport/sessions/trace';
import { dispatchSessionObservation, type RendererSessionObservationRegistry, type SessionPage } from './observations';
import { adaptSessionCreateRequest, adaptSessionDeleteRequest, adaptSessionRenameRequest, adaptSessionPermissionRequest, adaptSessionListRequest, adaptSessionAbortRequest, adaptSessionModelSelectionRequest } from './requests';
import { dispatchSessionTimeline, dispatchSessionContent, adaptSessionTimelineRequest, adaptSessionContentLoadRequest } from './timeline';
import { adaptSessionApprovalListRequest, projectSessionApprovalListResponse, adaptSessionApprovalRespondRequest } from './approvals';
import { dispatchSessionGoal, dispatchSessionSend } from './send';

export type SessionCapabilityDeps = Readonly<{
  runtimeHostTransports: Pick<RuntimeHostTransports,
    | 'sessionListTransport'
    | 'sessionTimelineTransport'
    | 'sessionObservationTransport'
    | 'sessionContentTransport'
    | 'sessionAbortTransport'
    | 'sessionCreateTransport'
    | 'sessionDeleteTransport'
    | 'sessionRenameTransport'
    | 'sessionApprovalTransport'
    | 'sessionSendTransport'
    | 'sessionGoalTransport'
    | 'sessionModelSelectionTransport'
    | 'sessionPermissionTransport'
    | 'sessionThinkingTransport'
  >;
  sessionObservers: RendererSessionObservationRegistry;
}>;

export async function dispatchSessionCapability(
  body: unknown,
  deps: SessionCapabilityDeps,
  traceId?: string | null,
  sessionPage?: SessionPage,
  signal?: AbortSignal,
): Promise<PublicTransportResponse | null> {
  if (!isRecord(body)) return null;
  logSessionTrace('capability.dispatch', traceId, () => ({
    id: typeof body.id === 'string' ? body.id : null,
    operationId: typeof body.operationId === 'string' ? body.operationId : null,
  }));

  if (body.id === 'session.management' && (body.operationId === 'sessions.observe' || body.operationId === 'sessions.release')) {
    return await dispatchSessionObservation(body, deps, sessionPage, traceId, signal);
  }
  if (body.id === 'session.prompt' && body.operationId === 'sessions.create') {
    return await deps.runtimeHostTransports.sessionCreateTransport.create(adaptSessionCreateRequest(body), traceId);
  }
  if ((body.id === 'session.prompt' || body.id === 'session.management')
    && body.operationId === 'sessions.load') {
    return await dispatchSessionTimeline(deps, adaptSessionTimelineRequest(body, 'sessions.load', traceId), 'load', traceId);
  }
  if (body.id === 'session.management' && body.operationId === 'sessions.window') {
    return await dispatchSessionTimeline(deps, adaptSessionTimelineRequest(body, 'sessions.window', traceId), 'window', traceId);
  }
  if (body.id === 'session.management' && body.operationId === 'sessions.content.load') {
    return await dispatchSessionContent(deps, adaptSessionContentLoadRequest(body, traceId), traceId);
  }
  if (body.id === 'session.management' && body.operationId === 'sessions.delete') {
    return await deps.runtimeHostTransports.sessionDeleteTransport.delete(adaptSessionDeleteRequest(body));
  }
  if (body.id === 'session.management' && body.operationId === 'sessions.rename') {
    return await deps.runtimeHostTransports.sessionRenameTransport.rename(adaptSessionRenameRequest(body));
  }
  if (body.id === 'session.management'
    && (body.operationId === 'sessions.permission.get' || body.operationId === 'sessions.permission.set')) {
    return await dispatchSessionPermission(
      deps,
      adaptSessionPermissionRequest(body, body.operationId, traceId),
      body.operationId,
      traceId,
    );
  }
  if (body.id === 'session.thinking') {
    if (!isSessionThinkingRequest(body)) {
      return { status: 400, body: { success: false, error: 'Session thinking request is invalid' } };
    }
    const method = body.operationId === 'sessions.thinking.get' ? 'get' : 'set';
    return await deps.runtimeHostTransports.sessionThinkingTransport[method](body, traceId);
  }
  if (body.id === 'session.management' && body.operationId === 'sessions.list') {
    return await deps.runtimeHostTransports.sessionListTransport.list(adaptSessionListRequest(body));
  }
  if ((body.id === 'session.prompt' || body.id === 'session.abort')
    && body.operationId === 'sessions.abort') {
    logSessionTrace('capability.abort.dispatch', traceId);
    const request = adaptSessionAbortRequest(body, traceId);
    return traceId
      ? await deps.runtimeHostTransports.sessionAbortTransport.abort(request, traceId)
      : await deps.runtimeHostTransports.sessionAbortTransport.abort(request);
  }
  if (body.id === 'session.approval' && body.operationId === 'approvals.list') {
    const request = adaptSessionApprovalListRequest(body);
    const response = await deps.runtimeHostTransports.sessionApprovalTransport.list(request.native);
    return projectSessionApprovalListResponse(response, request);
  }
  if (body.id === 'session.approval' && body.operationId === 'approvals.resolve') {
    return await deps.runtimeHostTransports.sessionApprovalTransport.respond(adaptSessionApprovalRespondRequest(body));
  }
  if (body.id === 'session.modelSelection' && body.operationId === 'sessions.patchModel') {
    const request = adaptSessionModelSelectionRequest(body, traceId);
    return traceId === undefined
      ? await deps.runtimeHostTransports.sessionModelSelectionTransport.select(request)
      : await deps.runtimeHostTransports.sessionModelSelectionTransport.select(request, traceId);
  }
  if (body.id === 'session.prompt'
    && (body.operationId === 'sessions.prompt' || body.operationId === 'sessions.sendWithMedia')) {
    return await dispatchSessionSend(body, deps, traceId, sessionPage);
  }
  if (body.id === 'session.goal'
    && (body.operationId === 'sessions.goal.update' || body.operationId === 'sessions.goal.clear')) {
    return await dispatchSessionGoal(body, deps, traceId, sessionPage);
  }

  return null;
}

async function dispatchSessionPermission(
  deps: SessionCapabilityDeps,
  request: SessionPermissionRequest,
  operationId: SessionPermissionOperationId,
  traceId?: string | null,
): Promise<PublicTransportResponse> {
  const method = operationId === 'sessions.permission.get' ? 'get' : 'set';
  return traceId === undefined
    ? await deps.runtimeHostTransports.sessionPermissionTransport[method](request)
    : await deps.runtimeHostTransports.sessionPermissionTransport[method](request, traceId);
}
