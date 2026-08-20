import {
  consumeStagedAttachment,
  releaseStagedAttachments,
  stageWorkspaceMediaAttachment,
} from '../../main/ipc/dialog-attachment-staging';
import type { RendererEventRouteRegistry } from '../../main/renderer-event-routes';
import type { MatchaSessionListTransport } from '../../main/runtime-host-delivery/transport/sessions/matcha-list';
import type { SessionAbortRequest, SessionAbortTransport } from '../../main/runtime-host-delivery/transport/sessions/abort';
import type {
  SessionApprovalListRequest,
  SessionApprovalRespondRequest,
  SessionApprovalTransport,
} from '../../main/runtime-host-delivery/transport/sessions/approvals';
import type { SessionCreateTransport } from '../../main/runtime-host-delivery/transport/sessions/create';
import type { SessionDeleteTransport } from '../../main/runtime-host-delivery/transport/sessions/delete';
import type { SessionListTransport } from '../../main/runtime-host-delivery/transport/sessions/list';
import type { SessionModelSelectionRequest, SessionModelSelectionTransport } from '../../main/runtime-host-delivery/transport/sessions/model-selection';
import type { SessionRenameTransport } from '../../main/runtime-host-delivery/transport/sessions/rename';
import type { SessionSendRequest, SessionSendTransport } from '../../main/runtime-host-delivery/transport/sessions/send';
import type { SessionTimelineTransport } from '../../main/runtime-host-delivery/transport/sessions/timeline';
import type { WorkspaceMediaTransport } from '../../main/runtime-host-delivery/transport/workspace/media';
import {
  logSessionTrace,
  summarizeIdentifier,
} from '../../main/runtime-host-delivery/transport/sessions/trace';

const SESSION_SEND_UNAVAILABLE = { success: false, error: 'Session send is unavailable' } as const;
const SESSION_SEND_INVALID = { success: false, error: 'Session send request is invalid' } as const;
const WORKSPACE_MEDIA_INVALID = { success: false, error: 'Workspace media request is invalid' } as const;
const WORKSPACE_MEDIA_UNAVAILABLE = { success: false, error: 'Workspace media is unavailable' } as const;
const MAX_ATTACHMENTS = 16;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const MAX_MEDIA_BYTES = 50 * 1024 * 1024;

export type SessionCapabilityRouteDeps = Readonly<{
  sessionListTransport: SessionListTransport;
  sessionTimelineTransport: SessionTimelineTransport;
  matchaSessionListTransport: MatchaSessionListTransport;
  sessionAbortTransport: SessionAbortTransport;
  sessionCreateTransport: SessionCreateTransport;
  sessionDeleteTransport: SessionDeleteTransport;
  sessionRenameTransport: SessionRenameTransport;
  sessionApprovalTransport: SessionApprovalTransport;
  sessionSendTransport: SessionSendTransport;
  sessionModelSelectionTransport: SessionModelSelectionTransport;
  rendererEventRoutes: Pick<RendererEventRouteRegistry, 'issue' | 'isMatchaRoute' | 'release'>;
  workspaceMediaTransport?: WorkspaceMediaTransport;
}>;

type PublicTransportResponse = Readonly<{
  status: number;
  body: unknown;
}>;

type RuntimeEndpoint = Readonly<{
  kind: 'native-runtime';
  runtimeAdapterId: 'openclaw' | 'matcha-agent';
  runtimeInstanceId: 'local';
}>;

type SessionIdentity = Readonly<{
  endpoint: RuntimeEndpoint;
  agentId: string;
  sessionKey: string;
}>;

export async function dispatchSessionCapability(
  body: unknown,
  deps: SessionCapabilityRouteDeps,
  traceId?: string | null,
): Promise<PublicTransportResponse | null> {
  if (!isRecord(body)) return null;
  logSessionTrace('capability.dispatch', traceId, {
    id: typeof body.id === 'string' ? body.id : null,
    operationId: typeof body.operationId === 'string' ? body.operationId : null,
  });

  if (body.id === 'session.prompt' && body.operationId === 'sessions.create') {
    return await deps.sessionCreateTransport.create(adaptSessionCreateRequest(body), traceId);
  }
  if ((body.id === 'session.prompt' || body.id === 'session.management')
    && body.operationId === 'sessions.load') {
    return await dispatchSessionTimeline(deps, adaptSessionTimelineRequest(body, 'sessions.load'), 'load', traceId);
  }
  if (body.id === 'session.management' && body.operationId === 'sessions.window') {
    return await dispatchSessionTimeline(deps, adaptSessionTimelineRequest(body, 'sessions.window'), 'window', traceId);
  }
  if (body.id === 'session.management' && body.operationId === 'sessions.delete') {
    return await deps.sessionDeleteTransport.delete(adaptSessionDeleteRequest(body));
  }
  if (body.id === 'session.management' && body.operationId === 'sessions.rename') {
    return await deps.sessionRenameTransport.rename(adaptSessionRenameRequest(body));
  }
  if (body.id === 'session.management' && body.operationId === 'sessions.list') {
    const request = adaptSessionListRequest(body);
    const transport = isRecord(request.scope) && isRuntimeEndpoint(request.scope.endpoint)
      && request.scope.endpoint.runtimeAdapterId === 'openclaw'
      ? deps.sessionListTransport
      : deps.matchaSessionListTransport;
    return await transport.list(request);
  }
  if ((body.id === 'session.prompt' || body.id === 'session.abort')
    && body.operationId === 'sessions.abort') {
    return await deps.sessionAbortTransport.abort(adaptSessionAbortRequest(body));
  }
  if (body.id === 'session.approval' && body.operationId === 'approvals.list') {
    return await deps.sessionApprovalTransport.list(adaptSessionApprovalListRequest(body));
  }
  if (body.id === 'session.approval' && body.operationId === 'approvals.resolve') {
    return await deps.sessionApprovalTransport.respond(adaptSessionApprovalRespondRequest(body));
  }
  if (body.id === 'session.modelSelection' && body.operationId === 'sessions.patchModel') {
    return await deps.sessionModelSelectionTransport.select(adaptSessionModelSelectionRequest(body));
  }
  if (body.id === 'session.prompt'
    && (body.operationId === 'sessions.prompt' || body.operationId === 'sessions.sendWithMedia')) {
    return await dispatchSessionSend(body, deps, traceId);
  }
  if (body.id === 'workspace.media') {
    return await dispatchWorkspaceMedia(body, deps.workspaceMediaTransport);
  }

  return null;
}

async function dispatchSessionTimeline(
  deps: SessionCapabilityRouteDeps,
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
        ? await deps.sessionTimelineTransport[operation](request)
        : await deps.sessionTimelineTransport[operation](request, traceId);
  }
}

async function dispatchSessionSend(
  body: Record<string, unknown>,
  deps: SessionCapabilityRouteDeps,
  traceId?: string | null,
): Promise<PublicTransportResponse> {
  const request = await adaptSessionSendRequest(body, deps.rendererEventRoutes);
  try {
    logSessionTrace('capability.send.request', traceId, {
      adapter: request.scope.endpoint.runtimeAdapterId,
      sessionKey: summarizeIdentifier(request.input.sessionKey),
      endpointSessionId: summarizeIdentifier(request.input.endpointSessionId),
      runId: summarizeIdentifier(request.input.runId ?? request.input.idempotencyKey),
      attachmentCount: request.input.attachments.length,
    });
    const response = traceId === undefined
      ? await deps.sessionSendTransport.send(request)
      : await deps.sessionSendTransport.send(request, traceId);
    const projected = projectSessionSendResponse(response, request);
    logSessionTrace('capability.send.response', traceId, {
      status: response.status,
      projected: Boolean(projected),
      retainedRoute: projected && (
        (isQueuedSessionSendResponse(projected.body, request)
          && request.scope.endpoint.runtimeAdapterId === 'openclaw')
        || (isSucceededSessionSendResponse(projected.body, request)
          && deps.rendererEventRoutes.isMatchaRoute(request.scope.routeKey))
      ),
    });
    const retainsRoute = projected && (
      (isQueuedSessionSendResponse(projected.body, request)
        && request.scope.endpoint.runtimeAdapterId === 'openclaw')
      || (isSucceededSessionSendResponse(projected.body, request)
        && deps.rendererEventRoutes.isMatchaRoute(request.scope.routeKey))
    );
    if (!retainsRoute) deps.rendererEventRoutes.release(request.scope.routeKey);
    return projected ?? { status: 503, body: SESSION_SEND_UNAVAILABLE };
  } catch (error) {
    deps.rendererEventRoutes.release(request.scope.routeKey);
    throw error;
  }
}

type SessionSendResponse = Readonly<{
  status: 200 | 202 | 400 | 503;
  body: Readonly<{ outcome: 'queued'; runId: string; routeKey: string }>
    | Readonly<{
      outcome: 'succeeded';
      runId: string;
      routeKey?: string;
      status: 'started' | 'in_flight' | 'ok';
    }>
    | Readonly<{ outcome: 'target_rejected' | 'unknown' }>
    | typeof SESSION_SEND_INVALID
    | typeof SESSION_SEND_UNAVAILABLE;
}>;

function projectSessionSendResponse(
  response: PublicTransportResponse,
  request: SessionSendRequest,
): SessionSendResponse | null {
  if (response.status === 202 && isQueuedSessionSendResponse(response.body, request)) {
    return {
      status: 202,
      body: {
        outcome: 'queued',
        runId: response.body.runId,
        routeKey: request.scope.routeKey,
      },
    };
  }
  if (response.status === 200 && isSucceededSessionSendResponse(response.body, request)) {
    return {
      status: 200,
      body: {
        outcome: 'succeeded',
        runId: response.body.runId,
        ...(request.scope.endpoint.runtimeAdapterId === 'matcha-agent'
          ? { routeKey: request.scope.routeKey }
          : {}),
        status: response.body.status,
      },
    };
  }
  if (response.status === 200 && isTerminalSessionSendResponse(response.body)) {
    return { status: 200, body: { outcome: response.body.outcome } };
  }
  if (response.status === 400 && isExactFailure(response.body, SESSION_SEND_INVALID)) {
    return { status: 400, body: SESSION_SEND_INVALID };
  }
  if (response.status === 503 && isExactFailure(response.body, SESSION_SEND_UNAVAILABLE)) {
    return { status: 503, body: SESSION_SEND_UNAVAILABLE };
  }
  return null;
}

function isQueuedSessionSendResponse(value: unknown, request: SessionSendRequest): value is Readonly<{
  outcome: 'queued';
  runId: string;
  routeKey?: string;
}> {
  const expectedRunId = request.input.runId ?? request.input.idempotencyKey;
  return request.scope.endpoint.runtimeAdapterId === 'openclaw'
    && isRecord(value)
    && hasAllowedKeys(value, ['outcome', 'runId'], ['routeKey'])
    && value.outcome === 'queued'
    && value.runId === expectedRunId;
}

function isSucceededSessionSendResponse(value: unknown, request: SessionSendRequest): value is Readonly<{
  outcome: 'succeeded';
  routeKey?: string;
  runId: string;
  status: 'started' | 'in_flight' | 'ok';
}> {
  const expectedRunId = request.input.runId ?? request.input.idempotencyKey;
  return isRecord(value)
    && hasAllowedKeys(value, ['outcome', 'runId', 'status'], ['routeKey'])
    && value.outcome === 'succeeded'
    && value.runId === expectedRunId
    && (value.status === 'started' || value.status === 'in_flight' || value.status === 'ok')
    && (value.routeKey === undefined || value.routeKey === request.scope.routeKey);
}

function isTerminalSessionSendResponse(value: unknown): value is Readonly<{
  outcome: 'target_rejected' | 'unknown';
}> {
  return isRecord(value)
    && hasExactKeys(value, ['outcome'])
    && (value.outcome === 'target_rejected' || value.outcome === 'unknown');
}

function isExactFailure(
  value: unknown,
  expected: typeof SESSION_SEND_INVALID | typeof SESSION_SEND_UNAVAILABLE,
): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['success', 'error'])
    && value.success === expected.success
    && value.error === expected.error;
}

async function dispatchWorkspaceMedia(
  body: Record<string, unknown>,
  transport: WorkspaceMediaTransport | undefined,
): Promise<PublicTransportResponse> {
  if (body.operationId === 'media.resolve') {
    return { status: 400, body: WORKSPACE_MEDIA_INVALID };
  }
  const request = decodeWorkspaceMediaRequest(body);
  if (!request) return { status: 400, body: WORKSPACE_MEDIA_INVALID };

  if (request.operationId === 'media.stagePaths'
    && request.input.paths.some((path) => 'gatewayUrl' in path)) {
    return { status: 400, body: WORKSPACE_MEDIA_INVALID };
  }
  if (!transport) {
    return { status: 503, body: WORKSPACE_MEDIA_UNAVAILABLE };
  }

  if (request.operationId === 'media.thumbnail') {
    const response = await executeWorkspaceMedia(transport, request);
    return response.status === 200 && isMediaThumbnail(response.body)
      ? { status: 200, body: response.body }
      : { status: 200, body: EMPTY_MEDIA_THUMBNAIL };
  }

  if (request.operationId === 'media.thumbnails') {
    const response = await executeWorkspaceMedia(transport, request);
    if (response.status === 200 && isMediaThumbnailsResponse(response.body)) {
      const thumbnails: Record<string, MediaThumbnail> = {};
      for (const path of request.input.paths) {
        setMediaThumbnail(thumbnails, path.key, response.body[path.key] ?? EMPTY_MEDIA_THUMBNAIL);
      }
      return { status: 200, body: thumbnails };
    }
    const thumbnails: Record<string, MediaThumbnail> = {};
    for (const path of request.input.paths) {
      setMediaThumbnail(thumbnails, path.key, EMPTY_MEDIA_THUMBNAIL);
    }
    return { status: 200, body: thumbnails };
  }

  if (request.operationId === 'media.stagePaths') {
    const staged = await executeWorkspaceMedia(transport, request);
    if (staged.status !== 200 || !Array.isArray(staged.body) || !staged.body.every(isPreparedMedia)) {
      return projectWorkspaceMediaFailure(staged);
    }
    const attachments: StagedMediaAttachment[] = [];
    for (const receipt of staged.body) {
      const attachment = await resolveAndStageMedia(receipt, request, transport);
      if (!attachment) {
        await releaseStagedAttachments(attachments.map((item) => item.stagedAttachmentId));
        return { status: 503, body: WORKSPACE_MEDIA_UNAVAILABLE };
      }
      attachments.push(attachment);
    }
    return { status: 200, body: attachments };
  }

  const staged = await executeWorkspaceMedia(transport, request);
  if (staged.status !== 200) return projectWorkspaceMediaFailure(staged);

  if (request.operationId === 'media.stageBuffer') {
    if (!isPreparedMedia(staged.body)) return { status: 503, body: WORKSPACE_MEDIA_UNAVAILABLE };
    const attachment = await resolveAndStageMedia(staged.body, request, transport!);
    return attachment
      ? { status: 200, body: attachment }
      : { status: 503, body: WORKSPACE_MEDIA_UNAVAILABLE };
  }

  if (!isPreparedMedia(staged.body)) return { status: 503, body: WORKSPACE_MEDIA_UNAVAILABLE };
  const attachment = await resolveAndStageMedia(staged.body, request, transport!);
  return attachment
    ? { status: 200, body: attachment }
    : { status: 503, body: WORKSPACE_MEDIA_UNAVAILABLE };
}

const EMPTY_MEDIA_THUMBNAIL = { preview: null, fileSize: 0 } as const;

function setMediaThumbnail(
  output: Record<string, MediaThumbnail>,
  key: string,
  value: MediaThumbnail,
): void {
  Object.defineProperty(output, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

type WorkspaceMediaOperation =
  | WorkspaceMediaPrepareRequest
  | WorkspaceMediaResolveRequest
  | WorkspaceMediaThumbnailRequest
  | WorkspaceMediaThumbnailsRequest
  | WorkspaceMediaStagePathsRequest
  | WorkspaceMediaStageBufferRequest;

type WorkspaceMediaScope = Readonly<{
  kind: 'session';
  endpoint: RuntimeEndpoint;
  sessionKey: string;
}>;

type WorkspaceMediaTarget = Readonly<{ kind: 'workspace-media' }>;

type WorkspaceMediaPrepareRequest = Readonly<{
  id: 'workspace.media';
  operationId: 'media.prepare';
  scope: WorkspaceMediaScope;
  target: WorkspaceMediaTarget;
  input: Readonly<{
    endpoint: RuntimeEndpoint;
    sessionKey: string;
    relativePath: string;
    mimeType: string;
  }>;
}>;

type WorkspaceMediaResolveRequest = Readonly<{
  id: 'workspace.media';
  operationId: 'media.resolve';
  scope: WorkspaceMediaScope;
  target: WorkspaceMediaTarget;
  input: Readonly<{
    endpoint: RuntimeEndpoint;
    sessionKey: string;
    reference: string;
  }>;
}>;

type WorkspaceMediaThumbnailRequest = Omit<WorkspaceMediaPrepareRequest, 'operationId' | 'input'> & Readonly<{
  operationId: 'media.thumbnail';
  input: WorkspaceMediaThumbnailInput;
}>;

type WorkspaceMediaThumbnailInput = Readonly<{
  endpoint: RuntimeEndpoint;
  sessionKey: string;
  relativePath: string;
  mimeType: string;
}> | Readonly<{
  endpoint: RuntimeEndpoint;
  sessionKey: string;
  gatewayUrl: string;
  mimeType: string;
  agentId: string;
}>;

type WorkspaceMediaPath = Readonly<{
  key: string;
  relativePath: string;
  mimeType: string;
}> | Readonly<{
  key: string;
  gatewayUrl: string;
  mimeType: string;
  agentId: string;
}>;

type WorkspaceMediaThumbnailsRequest = Omit<WorkspaceMediaPrepareRequest, 'operationId' | 'input'> & Readonly<{
  operationId: 'media.thumbnails';
  input: Readonly<{
    endpoint: RuntimeEndpoint;
    sessionKey: string;
    paths: readonly WorkspaceMediaPath[];
  }>;
}>;

type WorkspaceMediaStagePathsRequest = Omit<WorkspaceMediaThumbnailsRequest, 'operationId'> & Readonly<{
  operationId: 'media.stagePaths';
}>;

type WorkspaceMediaStageBufferRequest = Omit<WorkspaceMediaPrepareRequest, 'operationId' | 'input'> & Readonly<{
  operationId: 'media.stageBuffer';
  input: Readonly<{
    endpoint: RuntimeEndpoint;
    sessionKey: string;
    fileName: string;
    mimeType: string;
    base64: string;
  }>;
}>;

type PreparedMedia = Readonly<{
  reference: string;
  name: string;
  mimeType: string;
  size: number;
  preview: string | null;
}>;

type StagedMediaAttachment = Readonly<{
  stagedAttachmentId: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  preview: string | null;
}>;

type MediaThumbnail = Readonly<{ preview: string | null; fileSize: number }>;

type MediaThumbnailsResponse = Readonly<Record<string, MediaThumbnail>>;

async function executeWorkspaceMedia(
  transport: WorkspaceMediaTransport,
  request: WorkspaceMediaOperation,
): Promise<PublicTransportResponse> {
  try {
    const response: unknown = await transport.execute(request);
    return isPublicTransportResponse(response)
      ? response
      : { status: 503, body: WORKSPACE_MEDIA_UNAVAILABLE };
  } catch {
    return { status: 503, body: WORKSPACE_MEDIA_UNAVAILABLE };
  }
}

async function resolveAndStageMedia(
  prepared: PreparedMedia,
  request: WorkspaceMediaOperation,
  transport: WorkspaceMediaTransport,
): Promise<StagedMediaAttachment | null> {
  const resolved = await executeWorkspaceMedia(transport, {
    id: 'workspace.media',
    operationId: 'media.resolve',
    scope: request.scope,
    target: request.target,
    input: {
      endpoint: request.input.endpoint,
      sessionKey: request.input.sessionKey,
      reference: prepared.reference,
    },
  });
  if (resolved.status !== 200 || !isResolvedMedia(resolved.body)) return null;
  const content = decodeCanonicalBase64(resolved.body.data);
  if (!content || content.length !== prepared.size || content.length > MAX_MEDIA_BYTES) return null;
  try {
    const attachment = await stageWorkspaceMediaAttachment({
      name: prepared.name,
      mimeType: prepared.mimeType,
      content,
      preview: prepared.preview,
    });
    return isStagedMediaAttachment(attachment) ? attachment : null;
  } catch {
    return null;
  }
}

function decodeWorkspaceMediaRequest(body: Record<string, unknown>): WorkspaceMediaOperation | null {
  if (!hasExactKeys(body, ['id', 'operationId', 'scope', 'target', 'input'])
    || body.id !== 'workspace.media'
    || typeof body.operationId !== 'string'
    || !isRecord(body.scope)
    || !hasExactKeys(body.scope, ['kind', 'endpoint', 'sessionKey'])
    || body.scope.kind !== 'session'
    || !isOpenClawEndpoint(body.scope.endpoint)
    || !isIdentifier(body.scope.sessionKey)
    || !isRecord(body.target)
    || !hasExactKeys(body.target, ['kind'])
    || body.target.kind !== 'workspace-media'
    || !isRecord(body.input)
    || !isOpenClawEndpoint(body.input.endpoint)
    || body.input.sessionKey !== body.scope.sessionKey) {
    return null;
  }

  const scope: WorkspaceMediaScope = {
    kind: 'session',
    endpoint: body.scope.endpoint,
    sessionKey: body.scope.sessionKey,
  };
  const target: WorkspaceMediaTarget = { kind: 'workspace-media' };
  const input = body.input;
  const endpoint = input.endpoint as RuntimeEndpoint;
  const sessionKey = input.sessionKey as string;
  if (body.operationId === 'media.resolve') {
    if (!hasExactKeys(input, ['endpoint', 'sessionKey', 'reference'])
      || !isMediaReference(input.reference)) return null;
    return {
      id: 'workspace.media',
      operationId: 'media.resolve',
      scope,
      target,
      input: {
        endpoint,
        sessionKey,
        reference: input.reference,
      },
    };
  }
  if (body.operationId === 'media.prepare') {
    if (!hasExactKeys(input, ['endpoint', 'sessionKey', 'relativePath', 'mimeType'])
      || !isRelativePath(input.relativePath)
      || !isIdentifier(input.mimeType)) return null;
    return {
      id: 'workspace.media',
      operationId: body.operationId,
      scope,
      target,
      input: {
        endpoint,
        sessionKey,
        relativePath: input.relativePath,
        mimeType: input.mimeType,
      },
    };
  }
  if (body.operationId === 'media.thumbnail') {
    if (!hasExactKeys(input, ['endpoint', 'sessionKey', 'relativePath', 'mimeType'])
      && !hasExactKeys(input, ['endpoint', 'sessionKey', 'gatewayUrl', 'mimeType', 'agentId'])) return null;
    if (!isWorkspaceMediaThumbnailInput(input)) return null;
    return {
      id: 'workspace.media',
      operationId: body.operationId,
      scope,
      target,
      input,
    } as WorkspaceMediaThumbnailRequest;
  }
  if (body.operationId === 'media.thumbnails' || body.operationId === 'media.stagePaths') {
    if (!hasExactKeys(input, ['endpoint', 'sessionKey', 'paths'])
      || !Array.isArray(input.paths)
      || input.paths.length === 0
      || input.paths.length > 256
      || !input.paths.every(isWorkspaceMediaPath)) return null;
    return {
      id: 'workspace.media',
      operationId: body.operationId,
      scope,
      target,
      input: {
        endpoint,
        sessionKey,
        paths: input.paths,
      },
    } as WorkspaceMediaThumbnailsRequest | WorkspaceMediaStagePathsRequest;
  }
  if (body.operationId === 'media.stageBuffer') {
    if (!hasExactKeys(input, ['endpoint', 'sessionKey', 'fileName', 'mimeType', 'base64'])
      || !isSafeFileName(input.fileName)
      || !isIdentifier(input.mimeType)
      || !isBoundedCanonicalBase64(input.base64, MAX_ATTACHMENT_BYTES)) return null;
    return {
      id: 'workspace.media',
      operationId: 'media.stageBuffer',
      scope,
      target,
      input: {
        endpoint,
        sessionKey,
        fileName: input.fileName,
        mimeType: input.mimeType,
        base64: input.base64,
      },
    };
  }
  return null;
}

function isWorkspaceMediaThumbnailInput(
  value: Record<string, unknown>,
): value is WorkspaceMediaThumbnailInput {
  return (hasExactKeys(value, ['endpoint', 'sessionKey', 'relativePath', 'mimeType'])
    && isRelativePath(value.relativePath)
    && isIdentifier(value.mimeType))
    || (hasExactKeys(value, ['endpoint', 'sessionKey', 'gatewayUrl', 'mimeType', 'agentId'])
      && isGatewayUrl(value.gatewayUrl)
      && isIdentifier(value.mimeType)
      && isIdentifier(value.agentId));
}

function isWorkspaceMediaPath(value: unknown): value is WorkspaceMediaPath {
  return isRecord(value)
    && isIdentifier(value.key)
    && ((hasExactKeys(value, ['key', 'relativePath', 'mimeType'])
      && isRelativePath(value.relativePath)
      && isIdentifier(value.mimeType))
      || (hasExactKeys(value, ['key', 'gatewayUrl', 'mimeType', 'agentId'])
        && isGatewayUrl(value.gatewayUrl)
        && isIdentifier(value.mimeType)
        && isIdentifier(value.agentId)));
}

function isGatewayUrl(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 4096
    && !hasControlCharacter(value)
    && /^\/?api\/chat\/media\/outgoing\/[^/]+\/[^/]+(?:\/[^/]*)?$/.test(value);
}

function isMediaReference(value: unknown): value is string {
  return typeof value === 'string' && /^media_[a-f0-9]{32}$/.test(value);
}

function isPreparedMedia(value: unknown): value is PreparedMedia {
  return isRecord(value)
    && hasExactKeys(value, ['reference', 'name', 'mimeType', 'size', 'preview'])
    && isMediaReference(value.reference)
    && isSafeFileName(value.name)
    && isIdentifier(value.mimeType)
    && isSafeNonNegativeInteger(value.size)
    && value.size <= MAX_MEDIA_BYTES
    && (value.preview === null || typeof value.preview === 'string');
}

function isResolvedMedia(value: unknown): value is Readonly<{ data: string }> {
  return isRecord(value) && hasExactKeys(value, ['data']) && typeof value.data === 'string';
}

function isMediaThumbnail(value: unknown): value is MediaThumbnail {
  return isRecord(value)
    && hasExactKeys(value, ['preview', 'fileSize'])
    && (value.preview === null || typeof value.preview === 'string')
    && isSafeNonNegativeInteger(value.fileSize)
    && value.fileSize <= MAX_MEDIA_BYTES;
}

function isMediaThumbnailsResponse(value: unknown): value is MediaThumbnailsResponse {
  return isRecord(value)
    && Object.keys(value).length <= 256
    && Object.entries(value).every(([key, thumbnail]) => isIdentifier(key) && isMediaThumbnail(thumbnail));
}

function isStagedMediaAttachment(value: unknown): value is StagedMediaAttachment {
  return isRecord(value)
    && hasExactKeys(value, ['stagedAttachmentId', 'fileName', 'mimeType', 'fileSize', 'preview'])
    && isIdentifier(value.stagedAttachmentId)
    && isSafeFileName(value.fileName)
    && isIdentifier(value.mimeType)
    && isSafeNonNegativeInteger(value.fileSize)
    && value.fileSize <= MAX_ATTACHMENT_BYTES
    && (value.preview === null || typeof value.preview === 'string');
}

function isBoundedCanonicalBase64(value: unknown, byteLimit: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length % 4 === 0
    && value.length <= Math.ceil(byteLimit / 3) * 4
    && /^[A-Za-z0-9+/]*={0,2}$/.test(value)
    && Buffer.from(value, 'base64').toString('base64') === value
    && Buffer.byteLength(Buffer.from(value, 'base64')) <= byteLimit;
}

function projectWorkspaceMediaFailure(response: PublicTransportResponse): PublicTransportResponse {
  if (response.status === 422 && isPublicMediaFailure(response.body)) {
    return { status: 422, body: response.body };
  }
  return { status: 503, body: WORKSPACE_MEDIA_UNAVAILABLE };
}

function adaptSessionCreateRequest(body: Record<string, unknown>): Record<string, unknown> {
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
    || !hasAllowedKeys(body.input, ['endpoint', 'agentId'], ['sessionKey', 'endpointSessionId'])
    || !isRuntimeEndpoint(body.input.endpoint)
    || !sameEndpoint(body.input.endpoint, body.scope.endpoint)
    || body.input.agentId !== body.scope.agentId
    || (body.input.sessionKey !== undefined && !isIdentifier(body.input.sessionKey))
    || (body.input.endpointSessionId !== undefined && !isIdentifier(body.input.endpointSessionId))) {
    throw new Error('Session create request is invalid');
  }
  const endpointSessionId = body.input.endpointSessionId as string | undefined
    ?? deriveEndpointSessionId(
      body.input.endpoint,
      body.input.agentId as string,
      body.input.sessionKey as string | undefined,
    );
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
      ...(endpointSessionId === undefined ? {} : { endpointSessionId }),
    },
  };
}

function deriveEndpointSessionId(
  endpoint: RuntimeEndpoint,
  agentId: string,
  sessionKey: string | undefined,
): string | undefined {
  if (sessionKey === undefined) return undefined;
  if (endpoint.runtimeAdapterId === 'matcha-agent') return sessionKey;
  const prefix = `agent:${agentId}:`;
  if (!sessionKey.startsWith(prefix)) return undefined;
  const endpointSessionId = sessionKey.slice(prefix.length);
  return isValidEndpointSessionId(endpointSessionId) ? endpointSessionId : undefined;
}

function isValidEndpointSessionId(value: string): boolean {
  return isIdentifier(value)
    && value.trim() === value
    && !value.toLowerCase().startsWith('agent:')
    && value.split(':').every((segment) => segment.length > 0);
}

function adaptSessionTimelineRequest(
  body: Record<string, unknown>,
  operationId: 'sessions.load' | 'sessions.window',
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
    throw new Error('Session timeline request is invalid');
  }

  const inputKeys = operationId === 'sessions.load'
    ? ['sessionKey', 'sessionIdentity', 'endpointSessionId', 'limit']
    : ['sessionKey', 'sessionIdentity', 'endpointSessionId', 'mode', 'limit', 'offset', 'includeCanonical'];
  if (!hasAllowedKeys(body.input, ['sessionKey', 'sessionIdentity'], inputKeys.slice(2))
    || !isSessionIdentity(body.input.sessionIdentity)
    || !sameIdentity(body.scope.identity, body.input.sessionIdentity)
    || body.input.sessionKey !== body.scope.identity.sessionKey
    || (body.input.endpointSessionId !== undefined && !isIdentifier(body.input.endpointSessionId))
    || (body.input.limit !== undefined && !isTimelineLimit(body.input.limit))) {
    throw new Error('Session timeline request is invalid');
  }
  if (operationId === 'sessions.load') {
    if (body.input.mode !== undefined || body.input.offset !== undefined || body.input.includeCanonical !== undefined) {
      throw new Error('Session timeline request is invalid');
    }
    return {
      id: 'session.management',
      operationId,
      scope: { kind: 'session', identity: body.scope.identity },
      target: { kind: 'session', identity: body.target.identity },
      input: {
        sessionKey: body.input.sessionKey,
        sessionIdentity: body.input.sessionIdentity,
        ...(body.input.endpointSessionId === undefined ? {} : { endpointSessionId: body.input.endpointSessionId }),
        ...(body.input.limit === undefined ? {} : { limit: body.input.limit }),
      },
    };
  }

  if (body.input.includeCanonical !== undefined && typeof body.input.includeCanonical !== 'boolean') {
    throw new Error('Session timeline request is invalid');
  }
  if (body.input.mode !== 'latest' && body.input.mode !== 'older' && body.input.mode !== 'newer') {
    throw new Error('Session timeline request is invalid');
  }
  if (body.input.mode === 'latest' && body.input.offset !== undefined) {
    throw new Error('Session timeline request is invalid');
  }
  if (body.input.offset !== undefined && !isSafeNonNegativeInteger(body.input.offset)) {
    throw new Error('Session timeline request is invalid');
  }
  return {
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
    },
  };
}

function adaptSessionDeleteRequest(body: Record<string, unknown>): Record<string, unknown> {
  if (!hasExactKeys(body, ['id', 'operationId', 'scope', 'target', 'input'])
    || body.id !== 'session.management'
    || body.operationId !== 'sessions.delete'
    || !isRecord(body.scope)
    || !hasExactKeys(body.scope, ['kind', 'identity'])
    || body.scope.kind !== 'session'
    || !isSessionIdentity(body.scope.identity)
    || !isOpenClawEndpoint(body.scope.identity.endpoint)
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

function adaptSessionRenameRequest(body: Record<string, unknown>): Record<string, unknown> {
  if (!hasExactKeys(body, ['id', 'operationId', 'scope', 'target', 'input'])
    || body.id !== 'session.management'
    || body.operationId !== 'sessions.rename'
    || !isRecord(body.scope)
    || !hasExactKeys(body.scope, ['kind', 'identity'])
    || body.scope.kind !== 'session'
    || !isSessionIdentity(body.scope.identity)
    || !isOpenClawEndpoint(body.scope.identity.endpoint)
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

function adaptSessionListRequest(body: Record<string, unknown>): Record<string, unknown> {
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

function adaptSessionAbortRequest(body: Record<string, unknown>): SessionAbortRequest {
  if (!hasExactKeys(body, ['id', 'operationId', 'scope', 'target', 'input'])
    || (body.id !== 'session.prompt' && body.id !== 'session.abort')
    || body.operationId !== 'sessions.abort'
    || !isRecord(body.scope)
    || !hasExactKeys(body.scope, ['kind', 'identity'])
    || body.scope.kind !== 'session'
    || !isSessionIdentity(body.scope.identity)
    || !isRecord(body.target)
    || !hasAllowedKeys(body.target, ['kind'], ['identity'])
    || body.target.kind !== 'session'
    || (body.target.identity !== undefined && (!isSessionIdentity(body.target.identity)
      || !sameIdentity(body.scope.identity, body.target.identity)))
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
    throw new Error('Session abort request is invalid');
  }
  const endpoint = body.scope.identity.endpoint;
  return {
    id: 'session.abort',
    operationId: 'sessions.abort',
    scope: { kind: 'session', endpoint, sessionKey: body.input.sessionKey as string },
    target: { kind: 'session' },
    input: {
      endpoint,
      sessionKey: body.input.sessionKey as string,
      ...(body.input.endpointSessionId === undefined ? {} : { endpointSessionId: body.input.endpointSessionId as string }),
      ...(body.input.runId === undefined ? {} : { runId: body.input.runId as string }),
      ...(body.input.approvalIds === undefined ? {} : { approvalIds: body.input.approvalIds as string[] }),
    },
  };
}

function adaptSessionApprovalListRequest(body: Record<string, unknown>): SessionApprovalListRequest {
  if (!hasExactKeys(body, ['id', 'operationId', 'scope', 'target', 'input'])
    || body.id !== 'session.approval'
    || body.operationId !== 'approvals.list'
    || !isRecord(body.scope)
    || !hasExactKeys(body.scope, ['kind', 'identity'])
    || body.scope.kind !== 'session'
    || !isSessionIdentity(body.scope.identity)
    || !isMatchaAgentIdentity(body.scope.identity)
    || !isRecord(body.target)
    || !hasExactKeys(body.target, ['kind', 'identity'])
    || body.target.kind !== 'session'
    || !isSessionIdentity(body.target.identity)
    || !isMatchaAgentIdentity(body.target.identity)
    || !sameIdentity(body.scope.identity, body.target.identity)
    || !isRecord(body.input)
    || !hasExactKeys(body.input, ['sessionIdentity'])
    || !isSessionIdentity(body.input.sessionIdentity)
    || !isMatchaAgentIdentity(body.input.sessionIdentity)
    || !sameIdentity(body.scope.identity, body.input.sessionIdentity)) {
    throw new Error('Session approval request is invalid');
  }
  const endpoint = body.scope.identity.endpoint;
  const sessionId = body.scope.identity.sessionKey;
  return {
    id: 'session.approval',
    operationId: 'sessions.approvals.list',
    scope: { kind: 'session', endpoint, sessionId },
    target: { kind: 'session' },
    input: { endpoint, sessionId },
  };
}

function adaptSessionApprovalRespondRequest(body: Record<string, unknown>): SessionApprovalRespondRequest {
  if (!hasExactKeys(body, ['id', 'operationId', 'scope', 'target', 'input'])
    || body.id !== 'session.approval'
    || body.operationId !== 'approvals.resolve'
    || !isRecord(body.scope)
    || !hasExactKeys(body.scope, ['kind', 'identity'])
    || body.scope.kind !== 'session'
    || !isSessionIdentity(body.scope.identity)
    || !isMatchaAgentIdentity(body.scope.identity)
    || !isRecord(body.target)
    || !hasExactKeys(body.target, ['kind', 'identity', 'approvalId'])
    || body.target.kind !== 'approval'
    || !isSessionIdentity(body.target.identity)
    || !isMatchaAgentIdentity(body.target.identity)
    || !sameIdentity(body.scope.identity, body.target.identity)
    || !isIdentifier(body.target.approvalId)
    || !isRecord(body.input)
    || !hasAllowedKeys(body.input, ['id', 'sessionKey', 'sessionIdentity', 'decision'], ['endpointSessionId'])
    || !isIdentifier(body.input.id)
    || !isIdentifier(body.input.sessionKey)
    || body.input.id !== body.target.approvalId
    || body.input.sessionKey !== body.scope.identity.sessionKey
    || (body.input.endpointSessionId !== undefined && !isIdentifier(body.input.endpointSessionId))
    || !isSessionIdentity(body.input.sessionIdentity)
    || !isMatchaAgentIdentity(body.input.sessionIdentity)
    || !sameIdentity(body.scope.identity, body.input.sessionIdentity)
    || !isApprovalDecision(body.input.decision)) {
    throw new Error('Session approval request is invalid');
  }
  const endpoint = body.scope.identity.endpoint;
  const sessionId = body.scope.identity.sessionKey;
  return {
    id: 'session.approval',
    operationId: 'sessions.approvals.respond',
    scope: { kind: 'session', endpoint, sessionId },
    target: { kind: 'approval' },
    input: {
      endpoint,
      sessionId,
      approvalId: body.target.approvalId,
      optionId: approvalDecisionToOptionId(body.input.decision),
    },
  };
}

function isMatchaAgentIdentity(
  value: SessionIdentity,
): value is SessionIdentity & Readonly<{
  endpoint: Readonly<{
    kind: 'native-runtime';
    runtimeAdapterId: 'matcha-agent';
    runtimeInstanceId: 'local';
  }>;
}> {
  return value.endpoint.runtimeAdapterId === 'matcha-agent';
}

function isApprovalDecision(value: unknown): value is 'allow-once' | 'allow-always' | 'deny' {
  return value === 'allow-once' || value === 'allow-always' || value === 'deny';
}

function approvalDecisionToOptionId(decision: 'allow-once' | 'allow-always' | 'deny'): string {
  switch (decision) {
    case 'allow-once':
      return 'allow_once';
    case 'allow-always':
      return 'allow_always';
    case 'deny':
      return 'reject_once';
  }
}

function adaptSessionModelSelectionRequest(body: Record<string, unknown>): SessionModelSelectionRequest {
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
    || body.input.sessionKey !== body.scope.identity.sessionKey
    || body.input.sessionKey !== body.input.sessionIdentity.sessionKey
    || !isIdentifier(body.input.modelSelectionId)
    || body.input.modelSelectionId !== body.target.modelSelectionId
    || (body.input.endpointSessionId !== undefined && !isIdentifier(body.input.endpointSessionId))) {
    throw new Error('Session model selection request is invalid');
  }
  const endpoint = body.scope.identity.endpoint;
  return {
    id: 'session.modelSelection',
    operationId: 'sessions.patchModel',
    scope: { kind: 'session', endpoint, sessionKey: body.input.sessionKey as string },
    target: { kind: 'model-selection' },
    input: {
      endpoint,
      sessionKey: body.input.sessionKey as string,
      modelSelectionId: (body.input.modelSelectionId as string).trim(),
    },
  };
}

async function adaptSessionSendRequest(
  body: Record<string, unknown>,
  rendererEventRoutes: Pick<RendererEventRouteRegistry, 'issue'>,
): Promise<SessionSendRequest> {
  if (!hasExactKeys(body, ['id', 'operationId', 'scope', 'target', 'input'])
    || body.id !== 'session.prompt'
    || (body.operationId !== 'sessions.prompt' && body.operationId !== 'sessions.sendWithMedia')
    || !isRecord(body.scope)
    || !hasExactKeys(body.scope, ['kind', 'identity'])
    || body.scope.kind !== 'session'
    || !isSessionIdentity(body.scope.identity)
    || !isRecord(body.target)
    || !hasAllowedKeys(body.target, ['kind'], ['identity'])
    || body.target.kind !== 'session'
    || (body.target.identity !== undefined && (!isSessionIdentity(body.target.identity)
      || !sameIdentity(body.scope.identity, body.target.identity)))
    || !isRecord(body.input)
    || !hasAllowedKeys(body.input, ['sessionKey', 'sessionIdentity', 'message'], [
      'runId',
      'endpointSessionId',
      'idempotencyKey',
      'deliver',
      'attachments',
      'media',
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
    || (body.input.attachments !== undefined && !Array.isArray(body.input.attachments))
    || (body.operationId === 'sessions.sendWithMedia'
      && (!Array.isArray(body.input.attachments) || body.input.attachments.length === 0))
    || (Array.isArray(body.input.attachments) && body.input.attachments.length > MAX_ATTACHMENTS)) {
    throw new Error('Session send request is invalid');
  }

  const endpoint = body.scope.identity.endpoint;
  const attachments = body.input.attachments ?? [];
  let totalBytes = 0;
  const projected = [];
  for (const attachment of attachments) {
    if (!isStagedAttachmentMetadata(attachment)) throw new Error('Session send request is invalid');
    totalBytes += attachment.fileSize;
    if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) throw new Error('Session send request is invalid');
    const content = await consumeStagedAttachment(attachment.stagedAttachmentId);
    if (content.length !== attachment.fileSize || content.length > MAX_ATTACHMENT_BYTES) {
      throw new Error('Session send attachment is unavailable');
    }
    projected.push({
      mimeType: attachment.mimeType,
      fileName: attachment.fileName,
      content: content.toString('base64'),
    });
  }

  const routeKey = rendererEventRoutes.issue({
    endpoint,
    agentId: body.scope.identity.agentId,
    sessionKey: body.input.sessionKey as string,
  });
  return {
    id: 'session.prompt',
    operationId: 'sessions.send',
    scope: { kind: 'session', endpoint, sessionKey: body.input.sessionKey as string, routeKey },
    target: { kind: 'session' },
    input: {
      endpoint,
      sessionKey: body.input.sessionKey as string,
      ...(body.input.endpointSessionId === undefined ? {} : { endpointSessionId: body.input.endpointSessionId as string }),
      message: body.input.message as string,
      ...(body.input.runId === undefined
        ? body.input.idempotencyKey === undefined ? {} : { idempotencyKey: body.input.idempotencyKey as string }
        : { runId: body.input.runId as string }),
      ...(body.input.deliver === undefined ? {} : { deliver: body.input.deliver as boolean }),
      attachments: projected,
    },
  };
}

function isPublicTransportResponse(value: unknown): value is PublicTransportResponse {
  return isRecord(value)
    && (value.status === 200 || value.status === 422 || value.status === 503)
    && Object.hasOwn(value, 'body');
}

function isPublicMediaFailure(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['success', 'error'])
    && value.success === false
    && [
      'Workspace media path is invalid',
      'Workspace media reference is invalid',
      'Workspace media target is not a file',
      'Workspace media target exceeds the limit',
    ].includes(value.error as string);
}

function isStagedAttachmentMetadata(value: unknown): value is Readonly<{
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
    && value.fileSize <= MAX_ATTACHMENT_BYTES;
}

function isSessionIdentity(value: unknown): value is SessionIdentity {
  return isRecord(value)
    && hasExactKeys(value, ['endpoint', 'agentId', 'sessionKey'])
    && isRuntimeEndpoint(value.endpoint)
    && isIdentifier(value.agentId)
    && isIdentifier(value.sessionKey);
}

function sameIdentity(left: SessionIdentity, right: SessionIdentity): boolean {
  return left.agentId === right.agentId
    && left.sessionKey === right.sessionKey
    && sameEndpoint(left.endpoint, right.endpoint);
}

function sameEndpoint(left: RuntimeEndpoint, right: RuntimeEndpoint): boolean {
  return left.kind === right.kind
    && left.runtimeAdapterId === right.runtimeAdapterId
    && left.runtimeInstanceId === right.runtimeInstanceId;
}

function isRuntimeEndpoint(value: unknown): value is RuntimeEndpoint {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'runtimeAdapterId', 'runtimeInstanceId'])
    && value.kind === 'native-runtime'
    && (value.runtimeAdapterId === 'openclaw' || value.runtimeAdapterId === 'matcha-agent')
    && value.runtimeInstanceId === 'local';
}

function isOpenClawEndpoint(value: unknown): value is RuntimeEndpoint {
  return isRuntimeEndpoint(value) && value.runtimeAdapterId === 'openclaw';
}

function isRelativePath(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 4096
    && !value.includes('\0')
    && !value.startsWith('/')
    && !value.startsWith('\\')
    && !value.includes(':')
    && value.split(/[\\/]/).every((part) => part !== '' && part !== '.' && part !== '..');
}

function isSafeFileName(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 255
    && !value.includes('/')
    && !value.includes('\\')
    && !hasControlCharacter(value)
    && value !== '.'
    && value !== '..';
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0');
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function decodeCanonicalBase64(value: string): Buffer | null {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  const content = Buffer.from(value, 'base64');
  return content.toString('base64') === value ? content : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function hasAllowedKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function isTimelineLimit(value: unknown): value is number {
  return isSafeNonNegativeInteger(value) && value <= 200;
}
