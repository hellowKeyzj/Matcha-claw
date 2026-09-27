import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { hasExactKeys, isRecord, sendLoopbackJson } from '../client';
import { logSessionTrace, summarizeIdentifier, traceHeader } from './trace';

const ROUTE_PATH = '/api/sessions/send';
const MAX_ATTACHMENTS = 16;
const MAX_ATTACHMENT_DECODED_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_DECODED_BYTES = 20 * 1024 * 1024;
const UNAVAILABLE = {
  success: false,
  error: 'Session send is unavailable',
} as const;

type Endpoint = Readonly<{
  kind: 'native-runtime';
  runtimeAdapterId: 'openclaw' | 'matcha-agent';
  runtimeInstanceId: 'local';
}>;

export type SessionSendAttachment = Readonly<{
  mimeType: string;
  fileName: string;
  content: string;
}>;

export type SessionSendRequest = Readonly<{
  id: 'session.prompt';
  operationId: 'sessions.send';
  scope: Readonly<{
    kind: 'session';
    endpoint: Endpoint;
    sessionKey: string;
    routeKey: string;
  }>;
  target: Readonly<{ kind: 'session' }>;
  input: Readonly<{
    endpoint: Endpoint;
    sessionKey: string;
    endpointSessionId?: string;
    message: string;
    runId?: string;
    idempotencyKey?: string;
    deliver?: boolean;
    attachments: readonly SessionSendAttachment[];
  }>;
}>;

type RustSessionSendResponse =
  | Readonly<{ outcome: 'queued'; runId: string }>
  | Readonly<{ outcome: 'succeeded'; runId: string; status: 'started' | 'in_flight' | 'ok' }>
  | Readonly<{ outcome: 'target_rejected' | 'unavailable' | 'unknown' }>;

type SessionSendResponse =
  | Readonly<{ outcome: 'queued'; runId: string }>
  | Readonly<{
    outcome: 'succeeded';
    runId: string;
    status: 'started' | 'in_flight' | 'ok';
  }>
  | Readonly<{ outcome: 'target_rejected' | 'unavailable' | 'unknown' }>;

type SessionSendInvalidRequest = Readonly<{
  success: false;
  error: 'Session send request is invalid';
}>;

const INVALID_REQUEST: SessionSendInvalidRequest = {
  success: false,
  error: 'Session send request is invalid',
};

type E2EProcess = typeof process & {
  __matchaclawE2ESessionSendBoundary?: Readonly<{
    stage: 'rejected-request' | 'http-response' | 'transport-failure';
    status?: number;
    contract?: 'valid' | 'invalid';
    elapsedMs?: number;
    attachmentShape?: Readonly<{
      count: number;
      contentLengths: readonly number[];
      canonicalBase64: boolean;
      mimeLengths: readonly number[];
      fileNameLengths: readonly number[];
      fileNamesSafe: boolean;
      routeKeyLength: number;
      requestRunIdentityLength: number;
    }>;
  }>;
};

function e2eAttachmentShape(request: SessionSendRequest): NonNullable<
  E2EProcess['__matchaclawE2ESessionSendBoundary']
>['attachmentShape'] {
  const contentLengths = request.input.attachments.map((attachment) => attachment.content.length);
  return {
    count: contentLengths.length,
    contentLengths,
    canonicalBase64: request.input.attachments.every(
      (attachment) => canonicalBase64DecodedBytes(attachment.content) !== null,
    ),
    mimeLengths: request.input.attachments.map((attachment) => attachment.mimeType.length),
    fileNameLengths: request.input.attachments.map((attachment) => attachment.fileName.length),
    fileNamesSafe: request.input.attachments.every(
      (attachment) => !attachment.fileName.includes('/')
        && !attachment.fileName.includes('\\')
        && !hasControlCharacter(attachment.fileName),
    ),
    routeKeyLength: request.scope.routeKey.length,
    requestRunIdentityLength: request.input.runId?.length ?? request.input.idempotencyKey?.length ?? 0,
  };
}

function publishE2ESessionSendBoundary(
  boundary: NonNullable<E2EProcess['__matchaclawE2ESessionSendBoundary']>,
): void {
  if (process.env.MATCHACLAW_E2E !== '1') return;
  Object.defineProperty(process as E2EProcess, '__matchaclawE2ESessionSendBoundary', {
    configurable: true,
    enumerable: false,
    value: Object.freeze(boundary),
    writable: false,
  });
}

export type SessionSendTransportResponse = Readonly<{
  status: 200 | 202 | 400 | 503;
  body: SessionSendResponse | SessionSendInvalidRequest | typeof UNAVAILABLE;
}>;

export interface SessionSendTransport {
  send(request: unknown, traceId?: string | null): Promise<SessionSendTransportResponse>;
}

export function createSessionSendTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): SessionSendTransport {
  return {
    async send(request: unknown, traceId?: string | null): Promise<SessionSendTransportResponse> {
      if (!isSessionSendRequest(request)) {
        publishE2ESessionSendBoundary({ stage: 'rejected-request' });
        logSessionTrace('electron.send.rejected', traceId, {});
        return { status: 503, body: UNAVAILABLE };
      }
      const startedAt = Date.now();
      logSessionTrace('electron.send.request', traceId, {
        adapter: request.input.endpoint.runtimeAdapterId,
        sessionKey: summarizeIdentifier(request.input.sessionKey),
        endpointSessionId: summarizeIdentifier(request.input.endpointSessionId),
        runId: summarizeIdentifier(request.input.runId),
        idempotencyKey: summarizeIdentifier(request.input.idempotencyKey),
        attachmentCount: request.input.attachments.length,
      });
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        path: ROUTE_PATH,
        issuer,
        decision: {
          endpoint: ROUTE_PATH,
          scope: 'sessions:write',
          capability: 'session.prompt',
          subject: 'session-send',
        },
        method: 'POST',
        fetcher,
        body: request,
        headers: traceHeader(traceId),
      });
      if (response === null) {
        publishE2ESessionSendBoundary({ stage: 'transport-failure' });
        logSessionTrace('electron.send.failure', traceId, {
          elapsedMs: Date.now() - startedAt,
        });
        return { status: 503, body: UNAVAILABLE };
      }
      const body = response.body;
      publishE2ESessionSendBoundary({
        stage: 'http-response',
        status: response.status,
        elapsedMs: Date.now() - startedAt,
        contract: isRustSessionSendResponse(body) ? 'valid' : 'invalid',
        attachmentShape: e2eAttachmentShape(request),
      });
      logSessionTrace('electron.send.response', traceId, {
        status: response.status,
        contract: isRustSessionSendResponse(body) ? 'valid' : 'invalid',
        outcome: isRustSessionSendResponse(body) ? body.outcome : null,
        elapsedMs: Date.now() - startedAt,
      });
      if (response.status === 202
        && request.scope.endpoint.runtimeAdapterId === 'openclaw'
        && isRustSessionSendResponse(body)
        && body.outcome === 'queued') {
        return {
          status: 202,
          body: { outcome: 'queued', runId: body.runId },
        };
      }
      if (response.status === 200 && isRustSessionSendResponse(body)) {
        if (body.outcome === 'succeeded') {
          return {
            status: 200,
            body: {
              outcome: 'succeeded',
              runId: body.runId,
              status: body.status,
            },
          };
        }
        if (body.outcome === 'target_rejected' || body.outcome === 'unavailable' || body.outcome === 'unknown') {
          return { status: 200, body };
        }
      }
      if (response.status === 400) {
        return { status: 400, body: INVALID_REQUEST };
      }
      return { status: 503, body: UNAVAILABLE };
    },
  };
}

function isRustSessionSendResponse(value: unknown): value is RustSessionSendResponse {
  if (!isRecord(value) || typeof value.outcome !== 'string') return false;
  if (value.outcome === 'queued') {
    return hasExactKeys(value, ['outcome', 'runId']) && typeof value.runId === 'string';
  }
  if (value.outcome === 'succeeded') {
    return hasExactKeys(value, ['outcome', 'runId', 'status'])
      && typeof value.runId === 'string'
      && (value.status === 'started' || value.status === 'in_flight' || value.status === 'ok');
  }
  return hasExactKeys(value, ['outcome'])
    && (value.outcome === 'target_rejected' || value.outcome === 'unavailable' || value.outcome === 'unknown');
}

function isSessionSendRequest(value: unknown): value is SessionSendRequest {
  if (!isRecord(value)
    || !hasExactKeys(value, ['id', 'operationId', 'scope', 'target', 'input'])
    || value.id !== 'session.prompt'
    || value.operationId !== 'sessions.send'
    || !isSessionScope(value.scope)
    || !isRecord(value.target)
    || !hasExactKeys(value.target, ['kind'])
    || value.target.kind !== 'session'
    || !isRecord(value.input)
    || !hasAllowedKeys(value.input, ['endpoint', 'sessionKey', 'message', 'attachments'], ['endpointSessionId', 'runId', 'idempotencyKey', 'deliver'])
    || !isEndpoint(value.input.endpoint)
    || value.scope.endpoint.runtimeAdapterId !== value.input.endpoint.runtimeAdapterId
    || value.scope.endpoint.runtimeInstanceId !== value.input.endpoint.runtimeInstanceId
    || value.scope.sessionKey !== value.input.sessionKey
    || typeof value.input.sessionKey !== 'string'
    || !value.input.sessionKey
    || (value.input.endpointSessionId !== undefined
      && (typeof value.input.endpointSessionId !== 'string' || !value.input.endpointSessionId))
    || typeof value.input.message !== 'string'
    || (value.input.runId !== undefined
      && (typeof value.input.runId !== 'string' || !value.input.runId))
    || (value.input.idempotencyKey !== undefined
      && (typeof value.input.idempotencyKey !== 'string' || !value.input.idempotencyKey))
    || (value.input.deliver !== undefined && typeof value.input.deliver !== 'boolean')
    || (value.input.runId === undefined && value.input.idempotencyKey === undefined)
    || !Array.isArray(value.input.attachments)
    || value.input.attachments.length > MAX_ATTACHMENTS
    || !value.input.attachments.every(isSessionSendAttachment)
    || value.input.attachments
      .map(decodedAttachmentBytes)
      .some((bytes) => bytes === null)
    || value.input.attachments
      .map(decodedAttachmentBytes)
      .some((bytes) => bytes !== null && bytes > MAX_ATTACHMENT_DECODED_BYTES)
    || value.input.attachments
      .map(decodedAttachmentBytes)
      .reduce<number>((total, bytes) => total + (bytes ?? 0), 0) > MAX_TOTAL_ATTACHMENT_DECODED_BYTES) {
    return false;
  }
  return isEndpoint(value.scope.endpoint);
}

function isSessionScope(value: unknown): value is SessionSendRequest['scope'] {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'endpoint', 'sessionKey', 'routeKey'])
    && value.kind === 'session'
    && isEndpoint(value.endpoint)
    && typeof value.sessionKey === 'string'
    && value.sessionKey.length > 0
    && isRendererRouteKey(value.routeKey);
}

function isRendererRouteKey(value: unknown): value is string {
  return typeof value === 'string'
    && /^renderer-route:[A-Za-z0-9_-]+$/.test(value)
    && value.length <= 128;
}

function isEndpoint(value: unknown): value is Endpoint {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'runtimeAdapterId', 'runtimeInstanceId'])
    && value.kind === 'native-runtime'
    && (value.runtimeAdapterId === 'openclaw' || value.runtimeAdapterId === 'matcha-agent')
    && value.runtimeInstanceId === 'local';
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
}

function isSessionSendAttachment(value: unknown): value is SessionSendAttachment {
  return isRecord(value)
    && hasExactKeys(value, ['mimeType', 'fileName', 'content'])
    && typeof value.mimeType === 'string'
    && value.mimeType.length > 0
    && value.mimeType.length <= 255
    && !hasControlCharacter(value.mimeType)
    && typeof value.fileName === 'string'
    && value.fileName.length > 0
    && value.fileName.length <= 255
    && !value.fileName.includes('/')
    && !value.fileName.includes('\\')
    && !hasControlCharacter(value.fileName)
    && typeof value.content === 'string'
    && canonicalBase64DecodedBytes(value.content) !== null;
}

function decodedAttachmentBytes(value: unknown): number | null {
  return isSessionSendAttachment(value) ? canonicalBase64DecodedBytes(value.content) : null;
}

function canonicalBase64DecodedBytes(value: string): number | null {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    return null;
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const terminal = value.charCodeAt(value.length - padding - 1);
  if ((padding === 1 && base64Value(terminal) % 4 !== 0)
    || (padding === 2 && base64Value(terminal) % 16 !== 0)) {
    return null;
  }
  return (value.length / 4) * 3 - padding;
}

function base64Value(codePoint: number): number {
  if (codePoint >= 65 && codePoint <= 90) return codePoint - 65;
  if (codePoint >= 97 && codePoint <= 122) return codePoint - 97 + 26;
  if (codePoint >= 48 && codePoint <= 57) return codePoint - 48 + 52;
  return codePoint === 43 ? 62 : 63;
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
