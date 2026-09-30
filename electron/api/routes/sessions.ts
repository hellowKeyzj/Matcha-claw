import {
  consumeStagedAttachment,
  releaseStagedAttachments,
  stageWorkspaceMediaAttachment,
} from '../../main/ipc/dialog-attachment-staging';
import type { RendererEventRouteRegistry } from '../../main/renderer-event-routes';
import type { RuntimeHostTransportContext } from '../context';
import type { SessionAbortRequest } from '../../main/runtime-host-delivery/transport/sessions/abort';
import type {
  SessionApprovalListRequest,
  SessionApprovalListTransportResponse,
  SessionApprovalRespondRequest,
} from '../../main/runtime-host-delivery/transport/sessions/approvals';
import type { SessionContentLoadRequest } from '../../main/runtime-host-delivery/transport/sessions/content';
import type { SessionModelSelectionRequest } from '../../main/runtime-host-delivery/transport/sessions/model-selection';
import type {
  SessionPermissionOperationId,
  SessionPermissionRequest,
} from '../../main/runtime-host-delivery/transport/sessions/permission';
import type { SessionSendRequest } from '../../main/runtime-host-delivery/transport/sessions/send';
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
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
const MAX_CONTENT_REF_BYTES = 512;

export type SessionCapabilityRouteDeps = RuntimeHostTransportContext<
  | 'sessionListTransport'
  | 'sessionTimelineTransport'
  | 'sessionContentTransport'
  | 'sessionAbortTransport'
  | 'sessionCreateTransport'
  | 'sessionDeleteTransport'
  | 'sessionRenameTransport'
  | 'sessionApprovalTransport'
  | 'sessionSendTransport'
  | 'sessionModelSelectionTransport'
  | 'sessionPermissionTransport'
  | 'workspaceMediaTransport'
> & Readonly<{
  rendererEventRoutes: Pick<RendererEventRouteRegistry, 'issue' | 'isMatchaRoute' | 'release'>;
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
  if (body.id === 'session.management' && body.operationId === 'sessions.list') {
    return await deps.runtimeHostTransports.sessionListTransport.list(adaptSessionListRequest(body));
  }
  if ((body.id === 'session.prompt' || body.id === 'session.abort')
    && body.operationId === 'sessions.abort') {
    logSessionTrace('capability.abort.dispatch', traceId, {});
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
    return await dispatchSessionSend(body, deps, traceId);
  }
  if (body.id === 'workspace.media') {
    return await dispatchWorkspaceMedia(body, deps.runtimeHostTransports.workspaceMediaTransport);
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
        ? await deps.runtimeHostTransports.sessionTimelineTransport[operation](request)
        : await deps.runtimeHostTransports.sessionTimelineTransport[operation](request, traceId);
  }
}

async function dispatchSessionContent(
  deps: SessionCapabilityRouteDeps,
  request: SessionContentLoadRequest,
  traceId?: string | null,
): Promise<PublicTransportResponse> {
  return traceId === undefined
    ? await deps.runtimeHostTransports.sessionContentTransport.load(request)
    : await deps.runtimeHostTransports.sessionContentTransport.load(request, traceId);
}

async function dispatchSessionPermission(
  deps: SessionCapabilityRouteDeps,
  request: SessionPermissionRequest,
  operationId: SessionPermissionOperationId,
  traceId?: string | null,
): Promise<PublicTransportResponse> {
  const method = operationId === 'sessions.permission.get' ? 'get' : 'set';
  return traceId === undefined
    ? await deps.runtimeHostTransports.sessionPermissionTransport[method](request)
    : await deps.runtimeHostTransports.sessionPermissionTransport[method](request, traceId);
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
      runId: summarizeIdentifier(request.input.runId),
      idempotencyKey: summarizeIdentifier(request.input.idempotencyKey),
      attachmentCount: request.input.attachments.length,
    });
    const response = traceId === undefined
      ? await deps.runtimeHostTransports.sessionSendTransport.send(request)
      : await deps.runtimeHostTransports.sessionSendTransport.send(request, traceId);
    const projected = projectSessionSendResponse(response, request);
    const retainsRoute = projected !== null && retainsSessionRoute(projected, request);
    logSessionTrace('capability.send.response', traceId, {
      status: response.status,
      projected: Boolean(projected),
      retainedRoute: retainsRoute,
    });
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
    | Readonly<{ outcome: 'target_rejected' | 'unavailable' | 'unknown' }>
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

function retainsSessionRoute(
  response: SessionSendResponse,
  request: SessionSendRequest,
): boolean {
  return isQueuedSessionSendResponse(response.body, request)
    || isSucceededSessionSendResponse(response.body, request)
    || isTerminalSessionSendResponse(response.body);
}

function isQueuedSessionSendResponse(value: unknown, request: SessionSendRequest): value is Readonly<{
  outcome: 'queued';
  runId: string;
  routeKey?: string;
}> {
  return request.scope.endpoint.runtimeAdapterId === 'openclaw'
    && isRecord(value)
    && hasAllowedKeys(value, ['outcome', 'runId'], ['routeKey'])
    && value.outcome === 'queued'
    && isIdentifier(value.runId)
    && (value.routeKey === undefined || value.routeKey === request.scope.routeKey);
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
    && isIdentifier(value.runId)
    && (request.scope.endpoint.runtimeAdapterId === 'openclaw' || value.runId === expectedRunId)
    && (value.status === 'started' || value.status === 'in_flight' || value.status === 'ok')
    && (value.routeKey === undefined || value.routeKey === request.scope.routeKey);
}

function isTerminalSessionSendResponse(value: unknown): value is Readonly<{
  outcome: 'target_rejected' | 'unavailable' | 'unknown';
}> {
  return isRecord(value)
    && hasExactKeys(value, ['outcome'])
    && (value.outcome === 'target_rejected' || value.outcome === 'unavailable' || value.outcome === 'unknown');
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
    && /^(?:\/?api\/chat\/media\/outgoing\/[^/\s]+\/[^/\s]+\/[^\s]*|https?:\/\/[^/\s]+\/api\/chat\/media\/outgoing\/[^/\s]+\/[^/\s]+\/[^\s]*)$/.test(value);
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

function adaptSessionTimelineRequest(
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
    logSessionTrace('electron.timeline.route.invalid', traceId, {
      operationId,
      reason: 'envelope',
      envelope: summarizeTimelineBody(body),
    });
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
    logSessionTrace('electron.timeline.route.invalid', traceId, {
      operationId,
      reason: 'input',
      envelope: summarizeTimelineBody(body),
    });
    throw new Error('Session timeline request is invalid');
  }
  if (operationId === 'sessions.load') {
    if (body.input.mode !== undefined || body.input.offset !== undefined || body.input.includeCanonical !== undefined) {
      logSessionTrace('electron.timeline.route.invalid', traceId, {
        operationId,
        reason: 'load-window-fields',
        envelope: summarizeTimelineBody(body),
      });
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
      },
    };
    logSessionTrace('electron.timeline.route.adapted', traceId, {
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
    logSessionTrace('electron.timeline.route.invalid', traceId, {
      operationId,
      reason: 'include-canonical',
      envelope: summarizeTimelineBody(body),
    });
    throw new Error('Session timeline request is invalid');
  }
  if (body.input.mode !== 'latest' && body.input.mode !== 'older' && body.input.mode !== 'newer') {
    logSessionTrace('electron.timeline.route.invalid', traceId, {
      operationId,
      reason: 'mode',
      envelope: summarizeTimelineBody(body),
    });
    throw new Error('Session timeline request is invalid');
  }
  if (body.input.mode === 'latest' && body.input.offset !== undefined) {
    logSessionTrace('electron.timeline.route.invalid', traceId, {
      operationId,
      reason: 'latest-offset',
      envelope: summarizeTimelineBody(body),
    });
    throw new Error('Session timeline request is invalid');
  }
  if (body.input.offset !== undefined && !isSafeNonNegativeInteger(body.input.offset)) {
    logSessionTrace('electron.timeline.route.invalid', traceId, {
      operationId,
      reason: 'offset',
      envelope: summarizeTimelineBody(body),
    });
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
    },
  };
  logSessionTrace('electron.timeline.route.adapted', traceId, {
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

function adaptSessionContentLoadRequest(
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
    logSessionTrace('electron.content.route.invalid', traceId, { envelope: summarizeTimelineBody(body) });
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
  logSessionTrace('electron.content.route.adapted', traceId, {
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

function adaptSessionPermissionRequest(
  body: Record<string, unknown>,
  operationId: SessionPermissionOperationId,
  traceId?: string | null,
): SessionPermissionRequest {
  if (!hasExactKeys(body, ['id', 'operationId', 'scope', 'target', 'input'])
    || body.id !== 'session.management'
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
    || !isRecord(body.input)
    || !hasExactKeys(body.input, operationId === 'sessions.permission.get'
      ? ['sessionKey', 'sessionIdentity']
      : ['sessionKey', 'sessionIdentity', 'permissionMode'])
    || !isSessionIdentity(body.input.sessionIdentity)
    || !sameIdentity(body.scope.identity, body.input.sessionIdentity)
    || body.input.sessionKey !== body.scope.identity.sessionKey
    || (operationId === 'sessions.permission.set' && !isSessionPermissionMode(body.input.permissionMode))) {
    logSessionTrace('electron.permission.route.invalid', traceId, {
      operationId,
      envelope: summarizePermissionBody(body),
    });
    throw new Error('Session permission request is invalid');
  }
  const request = {
    id: 'session.management',
    operationId,
    scope: { kind: 'session', identity: body.scope.identity },
    target: { kind: 'session', identity: body.target.identity },
    input: operationId === 'sessions.permission.get'
      ? {
          sessionKey: body.input.sessionKey,
          sessionIdentity: body.input.sessionIdentity,
        }
      : {
          sessionKey: body.input.sessionKey,
          sessionIdentity: body.input.sessionIdentity,
          permissionMode: body.input.permissionMode,
        },
  } satisfies SessionPermissionRequest;
  logSessionTrace('electron.permission.route.adapted', traceId, {
    operationId,
    adapter: body.scope.identity.endpoint.runtimeAdapterId,
    instance: body.scope.identity.endpoint.runtimeInstanceId,
    sessionKey: summarizeIdentifier(body.input.sessionKey as string),
    permissionMode: operationId === 'sessions.permission.set' ? body.input.permissionMode : null,
  });
  return request;
}

function summarizePermissionBody(body: Record<string, unknown>) {
  const scope = isRecord(body.scope) ? body.scope : null;
  const target = isRecord(body.target) ? body.target : null;
  const input = isRecord(body.input) ? body.input : null;
  return {
    bodyKeys: Object.keys(body).sort(),
    scopeIdentity: summarizeIdentityShape(scope?.identity),
    targetIdentity: summarizeIdentityShape(target?.identity),
    inputIdentity: summarizeIdentityShape(input?.sessionIdentity),
    inputSessionKey: summarizeString(input?.sessionKey),
    permissionMode: input?.permissionMode === undefined ? null : input.permissionMode,
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

function adaptSessionAbortRequest(body: Record<string, unknown>, traceId?: string | null): SessionAbortRequest {
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
    const input = isRecord(body.input) ? body.input : null;
    logSessionTrace('electron.abort.route.invalid', traceId, {
      reason: 'request-validation',
      sessionKey: summarizeString(input?.sessionKey),
      endpointSessionId: summarizeString(input?.endpointSessionId),
      runId: summarizeString(input?.runId),
      approvalIdsCount: Array.isArray(input?.approvalIds) ? input.approvalIds.length : null,
      emptyApprovalIds: Array.isArray(input?.approvalIds) && input.approvalIds.length === 0,
    });
    throw new Error('Session abort request is invalid');
  }
  const endpoint = body.scope.identity.endpoint;
  logSessionTrace('electron.abort.route.adapted', traceId, {
    adapter: endpoint.runtimeAdapterId,
    sessionKey: summarizeString(body.input.sessionKey),
    endpointSessionId: summarizeString(body.input.endpointSessionId),
    runId: summarizeString(body.input.runId),
    approvalIdsCount: Array.isArray(body.input.approvalIds) ? body.input.approvalIds.length : null,
    emptyApprovalIds: Array.isArray(body.input.approvalIds) && body.input.approvalIds.length === 0,
  });
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

type SessionApprovalListRouteRequest = Readonly<{
  native: SessionApprovalListRequest;
  identity: SessionIdentity & Readonly<{
    endpoint: Readonly<{
      kind: 'native-runtime';
      runtimeAdapterId: 'matcha-agent';
      runtimeInstanceId: 'local';
    }>;
  }>;
}>;

function adaptSessionApprovalListRequest(body: Record<string, unknown>): SessionApprovalListRouteRequest {
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
    || !hasExactKeys(body.input, ['endpointSessionId', 'sessionIdentity'])
    || !isIdentifier(body.input.endpointSessionId)
    || !isSessionIdentity(body.input.sessionIdentity)
    || !isMatchaAgentIdentity(body.input.sessionIdentity)
    || !sameIdentity(body.scope.identity, body.input.sessionIdentity)) {
    throw new Error('Session approval request is invalid');
  }
  const identity = body.scope.identity;
  const endpoint = identity.endpoint;
  const sessionId = body.input.endpointSessionId as string;
  return {
    identity,
    native: {
      id: 'session.approval',
      operationId: 'sessions.approvals.list',
      scope: { kind: 'session', endpoint, sessionId },
      target: { kind: 'session' },
      input: { endpoint, sessionId },
    },
  };
}

function projectSessionApprovalListResponse(
  response: SessionApprovalListTransportResponse,
  request: SessionApprovalListRouteRequest,
): PublicTransportResponse {
  if (response.status === 200 && isNativeApprovalListResponse(response.body)) {
    return {
      status: 200,
      body: {
        approvals: response.body.approvals.map((approval) => ({
          id: approval.approvalId,
          sessionKey: request.identity.sessionKey,
          sessionIdentity: request.identity,
          title: 'Approval required',
          allowedDecisions: approval.optionIds.map(nativeApprovalOptionIdToDecision).filter(isPublicApprovalDecision),
          request: { optionIds: approval.optionIds },
          createdAtMs: 0,
        })),
      },
    };
  }
  return response;
}

function isNativeApprovalListResponse(value: unknown): value is Readonly<{
  approvals: ReadonlyArray<Readonly<{ approvalId: string; optionIds: readonly string[] }>>;
}> {
  return isRecord(value)
    && hasExactKeys(value, ['approvals'])
    && Array.isArray(value.approvals)
    && value.approvals.every((approval) => isRecord(approval)
      && hasExactKeys(approval, ['approvalId', 'optionIds'])
      && isIdentifier(approval.approvalId)
      && Array.isArray(approval.optionIds)
      && approval.optionIds.every((optionId) => isIdentifier(optionId)));
}

function isPublicApprovalDecision(value: unknown): value is 'allow-once' | 'allow-always' | 'deny' {
  return value === 'allow-once' || value === 'allow-always' || value === 'deny';
}

function nativeApprovalOptionIdToDecision(optionId: string): 'allow-once' | 'allow-always' | 'deny' | null {
  switch (optionId) {
    case 'allow':
    case 'allow-once':
    case 'allow_once':
      return 'allow-once';
    case 'allow-always':
    case 'allow_always':
      return 'allow-always';
    case 'deny':
    case 'deny-once':
    case 'reject-once':
    case 'reject_once':
      return 'deny';
    default:
      return null;
  }
}

function approvalDecisionToOptionId(decision: 'allow-once' | 'allow-always' | 'deny', approval?: { request?: Record<string, unknown> }): string {
  const optionIds = approval?.request?.optionIds;
  if (Array.isArray(optionIds)) {
    const nativeOptionId = optionIds.find((optionId): optionId is string => (
      isIdentifier(optionId) && nativeApprovalOptionIdToDecision(optionId) === decision
    ));
    if (nativeOptionId) return nativeOptionId;
  }
  switch (decision) {
    case 'allow-once':
      return 'allow-once';
    case 'allow-always':
      return 'allow-always';
    case 'deny':
      return 'deny-once';
  }
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
    || !hasAllowedKeys(body.input, ['id', 'sessionKey', 'endpointSessionId', 'sessionIdentity', 'decision'], ['request'])
    || !isIdentifier(body.input.id)
    || !isIdentifier(body.input.sessionKey)
    || !isIdentifier(body.input.endpointSessionId)
    || body.input.id !== body.target.approvalId
    || body.input.sessionKey !== body.scope.identity.sessionKey
    || (body.input.request !== undefined && !isRecord(body.input.request))
    || !isSessionIdentity(body.input.sessionIdentity)
    || !isMatchaAgentIdentity(body.input.sessionIdentity)
    || !sameIdentity(body.scope.identity, body.input.sessionIdentity)
    || !isApprovalDecision(body.input.decision)) {
    throw new Error('Session approval request is invalid');
  }
  const endpoint = body.scope.identity.endpoint;
  const sessionId = body.input.endpointSessionId as string;
  const approval = body.input as { request?: Record<string, unknown> };
  return {
    id: 'session.approval',
    operationId: 'sessions.approvals.respond',
    scope: { kind: 'session', endpoint, sessionId },
    target: { kind: 'approval' },
    input: {
      endpoint,
      sessionId,
      approvalId: body.target.approvalId,
      optionId: approvalDecisionToOptionId(body.input.decision, approval),
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

function isSessionPermissionMode(value: unknown): value is null | 'read-only' | 'guarded' | 'workspace' | 'full' {
  return value === null
    || value === 'read-only'
    || value === 'guarded'
    || value === 'workspace'
    || value === 'full';
}

function adaptSessionModelSelectionRequest(body: Record<string, unknown>, traceId?: string | null): SessionModelSelectionRequest {
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
    logSessionTrace('electron.model-selection.route.invalid', traceId, {
      reason: explainSessionModelSelectionInvalid(body),
      envelope: summarizeSessionModelSelectionBody(body),
    });
    throw new Error('Session model selection request is invalid');
  }
  const endpoint = body.scope.identity.endpoint;
  const sessionKey = body.scope.identity.sessionKey;
  logSessionTrace('electron.model-selection.route.adapted', traceId, {
    adapter: endpoint.runtimeAdapterId,
    instance: endpoint.runtimeInstanceId,
    sessionKey: summarizeIdentifier(sessionKey),
    endpointSessionId: summarizeIdentifier(body.input.endpointSessionId as string | undefined),
    modelSelectionId: summarizeIdentifier(body.input.modelSelectionId as string),
  });
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
    bodyKeys: Object.keys(body).sort(),
    scopeKeys: scope ? Object.keys(scope).sort() : null,
    targetKeys: target ? Object.keys(target).sort() : null,
    inputKeys: input ? Object.keys(input).sort() : null,
    scopeIdentity: summarizeIdentityShape(scope?.identity),
    targetIdentity: summarizeIdentityShape(target?.identity),
    inputIdentity: summarizeIdentityShape(input?.sessionIdentity),
    inputSessionKey: summarizeString(input?.sessionKey),
    endpointSessionId: summarizeString(input?.endpointSessionId),
    targetModelSelectionId: summarizeString(target?.modelSelectionId),
    inputModelSelectionId: summarizeString(input?.modelSelectionId),
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

function summarizeString(value: unknown): { present: boolean; length: number } {
  return summarizeIdentifier(typeof value === 'string' ? value : null);
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

function isIdentifier(value: unknown, maxBytes = 4096): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= maxBytes && !value.includes('\0');
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

function isContentLimit(value: unknown): value is number {
  return isSafeNonNegativeInteger(value) && value > 0 && value <= 64 * 1024;
}
