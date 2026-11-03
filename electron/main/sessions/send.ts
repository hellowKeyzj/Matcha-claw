import { setImmediate } from 'node:timers/promises';
import { SESSION_ATTACHMENT_TRANSPORT_MAX_BYTES, SESSION_SEND_REQUEST_MAX_BYTES, sessionAttachmentMaxBytes } from '../../../src/types/session/attachments';
import { hasExactKeys, isRecord, isSafeNonNegativeInteger } from '../runtime-host-delivery/transport/client';
import type { LoopbackJsonResponse as PublicTransportResponse } from '../runtime-host-delivery/transport/client';
import { consumeStagedAttachments, releaseStagedAttachments } from '../attachments/staging';
import type { RuntimeHostTransports } from '../runtime-host-delivery/transport/host-api-transports';
import { decodeSessionGoalOutcome, decodeSessionGoalRequest, isGoalIdentifier, isGoalObjective, isSessionSendIntent } from '../runtime-host-delivery/transport/sessions/goal';
import type { SessionSendRequest } from '../runtime-host-delivery/transport/sessions/send';
import { sameSessionIdentity as sameIdentity } from '../runtime-host-delivery/transport/sessions/session-contract';
import { logSessionTrace, summarizeIdentifier } from '../runtime-host-delivery/transport/sessions/trace';
import type { RendererSessionObservationRegistry, SessionPage } from './observations';
import { hasAllowedKeys, isIdentifier, isSafeFileName, isSessionIdentity } from './request-validation';

type SessionSendDeps = Readonly<{
  runtimeHostTransports: Pick<RuntimeHostTransports, 'sessionSendTransport' | 'sessionGoalTransport'>;
  sessionObservers: RendererSessionObservationRegistry;
}>;

const MAX_ATTACHMENTS = 16;

export async function dispatchSessionGoal(
  body: Record<string, unknown>,
  deps: SessionSendDeps,
  traceId?: string | null,
  sessionPage?: SessionPage,
): Promise<PublicTransportResponse> {
  const request = decodeSessionGoalRequest(body);
  if (!request) return { status: 400, body: { success: false, error: 'Session Goal request is invalid' } };
  const demand = request.operationId === 'sessions.goal.update' && request.input.action === 'resume'
    ? deps.sessionObservers.beginSend(sessionPage, request.scope.identity)
    : null;
  let response: PublicTransportResponse;
  try {
    response = await deps.runtimeHostTransports.sessionGoalTransport.execute(request, traceId);
  } catch {
    if (demand) deps.sessionObservers.retainUnknownGoalSend(demand);
    return { status: 503, body: { outcome: 'unknown' } };
  }
  if (response.status === 400 && isRecord(response.body)
    && hasExactKeys(response.body, ['success', 'error']) && response.body.success === false
    && response.body.error === 'Session Goal request is invalid') {
    if (demand) deps.sessionObservers.releaseSend(demand);
    return response;
  }
  const outcome = decodeSessionGoalOutcome(response.body, request);
  if (!outcome || (response.status !== 200 && !(response.status === 503 && outcome.outcome === 'unknown'))) {
    if (demand) deps.sessionObservers.retainUnknownGoalSend(demand);
    return { status: 503, body: { outcome: 'unknown' } };
  }
  if (demand) {
    if (outcome.outcome === 'succeeded') {
      if (outcome.receipt.status === 'started' && !outcome.receipt.replayed && outcome.receipt.runId) {
        deps.sessionObservers.bindSend(demand, outcome.receipt.runId);
      } else deps.sessionObservers.releaseSend(demand);
    } else if (outcome.outcome === 'unknown') deps.sessionObservers.retainUnknownGoalSend(demand);
    else deps.sessionObservers.releaseSend(demand);
  }
  return { status: response.status, body: outcome };
}

export async function dispatchSessionSend(
  body: Record<string, unknown>,
  deps: SessionSendDeps,
  traceId?: string | null,
  sessionPage?: SessionPage,
): Promise<PublicTransportResponse> {
  const request = await adaptSessionSendRequest(body);
  const requestedRunId = request.input.intent === undefined
    ? request.input.runId ?? request.input.idempotencyKey : undefined;
  const demand = deps.sessionObservers.beginSend(sessionPage, request.scope.identity, requestedRunId);
  try {
    logSessionTrace('capability.send.request', traceId, () => ({
      adapter: request.scope.identity.endpoint.runtimeAdapterId,
      sessionKey: summarizeIdentifier(request.input.identity.sessionKey),
      endpointSessionId: summarizeIdentifier(request.input.endpointSessionId),
      runId: summarizeIdentifier(request.input.runId),
      idempotencyKey: summarizeIdentifier(request.input.idempotencyKey),
      attachmentCount: request.input.attachments.length,
    }));
    const response = traceId === undefined
      ? await deps.runtimeHostTransports.sessionSendTransport.send(request)
      : await deps.runtimeHostTransports.sessionSendTransport.send(request, traceId);
    if ('runId' in response.body) {
      if ('goal' in response.body && response.body.goal?.replayed) deps.sessionObservers.releaseSend(demand);
      else deps.sessionObservers.bindSend(demand, response.body.runId);
    }
    else if (response.status === 400 || (request.input.intent === undefined && response.status === 503) || ('outcome' in response.body
      && (response.body.outcome === 'target_rejected' || response.body.outcome === 'unavailable'
        || response.body.outcome === 'unsupported'))) {
      deps.sessionObservers.releaseSend(demand);
    } else if (request.input.intent !== undefined) deps.sessionObservers.retainUnknownGoalSend(demand);
    logSessionTrace('capability.send.response', traceId, () => ({
      status: response.status,
    }));
    return response;
  } catch {
    if (request.input.intent !== undefined) deps.sessionObservers.retainUnknownGoalSend(demand);
    return { status: 200, body: { outcome: 'unknown' } };
  }
}

async function adaptSessionSendRequest(
  body: Record<string, unknown>,
): Promise<SessionSendRequest> {
  const stagedAttachmentIds = isRecord(body.input) && Array.isArray(body.input.attachments)
    ? body.input.attachments.flatMap((attachment) => (
        isRecord(attachment) && isIdentifier(attachment.stagedAttachmentId) ? [attachment.stagedAttachmentId] : []
      ))
    : [];
  try {
    if (!hasExactKeys(body, ['id', 'operationId', 'scope', 'target', 'input'])
      || body.id !== 'session.prompt'
      || (body.operationId !== 'sessions.prompt' && body.operationId !== 'sessions.sendWithMedia')
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
      || !hasAllowedKeys(body.input, ['sessionKey', 'sessionIdentity', 'message'], [
        'runId',
        'endpointSessionId',
        'idempotencyKey',
        'deliver',
        'attachments',
        'media',
        'intent',
      ])
      || !isSessionIdentity(body.input.sessionIdentity)
      || !sameIdentity(body.scope.identity, body.input.sessionIdentity)
      || body.input.sessionKey !== body.scope.identity.sessionKey
      || typeof body.input.message !== 'string'
      || (body.input.runId !== undefined && !isIdentifier(body.input.runId))
      || body.input.media !== undefined
      || (body.input.endpointSessionId !== undefined && !isIdentifier(body.input.endpointSessionId))
      || (body.input.idempotencyKey !== undefined && !isIdentifier(body.input.idempotencyKey))
      || (body.input.deliver !== undefined && typeof body.input.deliver !== 'boolean')
      || (Object.hasOwn(body.input, 'intent') && (!isSessionSendIntent(body.input.intent)
        || body.input.runId !== undefined || !isGoalIdentifier(body.input.idempotencyKey, 128)
        || !isGoalObjective(body.input.message)))
      || (body.input.attachments !== undefined && !Array.isArray(body.input.attachments))
      || (body.operationId === 'sessions.sendWithMedia'
        && (!Array.isArray(body.input.attachments) || body.input.attachments.length === 0))
      || (Array.isArray(body.input.attachments) && body.input.attachments.length > MAX_ATTACHMENTS)) {
      throw new Error('Session send request is invalid');
    }

    const maxAttachmentBytes = sessionAttachmentMaxBytes(body.scope.identity.endpoint.runtimeAdapterId);
    const attachments: { mimeType: string; fileName: string; fileSize: number }[] = [];
    let totalBytes = 0;
    for (const attachment of body.input.attachments ?? []) {
      if (!isStagedAttachmentMetadata(attachment, maxAttachmentBytes)) throw new Error('Session send request is invalid');
      totalBytes += attachment.fileSize;
      if (totalBytes > SESSION_ATTACHMENT_TRANSPORT_MAX_BYTES) throw new Error('Session send request is invalid');
      attachments.push({ mimeType: attachment.mimeType, fileName: attachment.fileName, fileSize: attachment.fileSize });
    }
    // Snapshot validated caller data before consumption or inter-attachment yields.
    const identity = { ...body.scope.identity, endpoint: { ...body.scope.identity.endpoint } };
    const projected: SessionSendRequest['input']['attachments'][number][] = [];
    const request: SessionSendRequest = {
      id: 'session.prompt',
      operationId: 'sessions.send',
      scope: { kind: 'session', identity },
      target: { kind: 'session', identity },
      input: {
        identity,
        ...(body.input.endpointSessionId === undefined ? {} : { endpointSessionId: body.input.endpointSessionId as string }),
        message: body.input.message as string,
        ...(body.input.runId === undefined
          ? body.input.idempotencyKey === undefined ? {} : { idempotencyKey: body.input.idempotencyKey as string }
          : { runId: body.input.runId as string }),
        ...(body.input.deliver === undefined ? {} : { deliver: body.input.deliver as boolean }),
        ...(isSessionSendIntent(body.input.intent) ? { intent: { ...body.input.intent } } : {}),
        attachments: projected,
      },
    };
    const contents = attachments.length > 0 ? await consumeStagedAttachments(stagedAttachmentIds) : [];
    for (let index = 0; index < attachments.length; index += 1) {
      if (index > 0) await setImmediate();
      const attachment = attachments[index];
      const content = contents[index];
      if (content.length !== attachment.fileSize || content.length > maxAttachmentBytes) {
        throw new Error('Session send attachment is unavailable');
      }
      projected.push({
        mimeType: attachment.mimeType,
        fileName: attachment.fileName,
        content: content.toString('base64'),
      });
    }
    if (Buffer.byteLength(JSON.stringify(request), 'utf8') > SESSION_SEND_REQUEST_MAX_BYTES) {
      throw new Error('Session send request is invalid');
    }
    return request;
  } finally {
    // Renderer timeouts do not end this materialization task's custody of the batch.
    await releaseStagedAttachments(stagedAttachmentIds);
  }
}

function isStagedAttachmentMetadata(value: unknown, maxAttachmentBytes: number): value is Readonly<{
  stagedAttachmentId: string;
  mimeType: string;
  fileName: string;
  fileSize: number;
}> {
  return isRecord(value)
    && hasExactKeys(value, ['stagedAttachmentId', 'mimeType', 'fileName', 'fileSize'])
    && isIdentifier(value.stagedAttachmentId)
    && isIdentifier(value.mimeType)
    && isSafeFileName(value.fileName)
    && isSafeNonNegativeInteger(value.fileSize)
    && value.fileSize <= maxAttachmentBytes;
}
