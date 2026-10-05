import type { SessionGoalReceipt, SessionSendIntent } from '../../../../../src/types/session-goal';
import { decodeSessionGoalReceipt, isGoalIdentifier, isGoalObjective, isSessionSendIntent } from './goal';
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

import { isSessionIdentity, sameSessionIdentity, type SessionIdentity } from './session-contract';

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
    identity: SessionIdentity;
  }>;
  target: Readonly<{ kind: 'session'; identity: SessionIdentity }>;
  input: Readonly<{
    identity: SessionIdentity;
    endpointSessionId?: string;
    message: string;
    runId?: string;
    idempotencyKey?: string;
    deliver?: boolean;
    intent?: SessionSendIntent;
    attachments: readonly SessionSendAttachment[];
  }>;
}>;

type RustSessionSendResponse =
  | Readonly<{ outcome: 'queued'; runId: string }>
  | Readonly<{ outcome: 'succeeded'; runId: string; status: 'started' | 'in_flight' | 'ok'; goal?: SessionGoalReceipt }>
  | Readonly<{ outcome: 'target_rejected' | 'unavailable' | 'unknown' | 'unsupported' }>;

type SessionSendResponse =
  | Readonly<{ outcome: 'queued'; runId: string }>
  | Readonly<{
    outcome: 'succeeded';
    runId: string;
    status: 'started' | 'in_flight' | 'ok';
    goal?: SessionGoalReceipt;
  }>
  | Readonly<{ outcome: 'target_rejected' | 'unavailable' | 'unknown' | 'unsupported' }>;

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
      agentIdLength: number;
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
    agentIdLength: request.scope.identity.agentId.length,
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
        adapter: request.input.identity.endpoint.runtimeAdapterId,
        sessionKey: summarizeIdentifier(request.input.identity.sessionKey),
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
        return request.input.intent === undefined
          ? { status: 503, body: UNAVAILABLE }
          : { status: 200, body: { outcome: 'unknown' } };
      }
      const body = response.body;
      publishE2ESessionSendBoundary({
        stage: 'http-response',
        status: response.status,
        elapsedMs: Date.now() - startedAt,
        contract: isRustSessionSendResponse(body, request) ? 'valid' : 'invalid',
        attachmentShape: e2eAttachmentShape(request),
      });
      logSessionTrace('electron.send.response', traceId, {
        status: response.status,
        contract: isRustSessionSendResponse(body, request) ? 'valid' : 'invalid',
        outcome: isRustSessionSendResponse(body, request) ? body.outcome : null,
        elapsedMs: Date.now() - startedAt,
      });
      if (response.status === 202
        && request.scope.identity.endpoint.runtimeAdapterId === 'openclaw'
        && isRustSessionSendResponse(body, request)
        && body.outcome === 'queued') {
        return {
          status: 202,
          body: { outcome: 'queued', runId: body.runId },
        };
      }
      if (response.status === 200 && isRustSessionSendResponse(body, request)) {
        if (body.outcome === 'succeeded') {
          return {
            status: 200,
            body: {
              outcome: 'succeeded',
              runId: body.runId,
              status: body.status,
              ...(body.goal === undefined ? {} : { goal: body.goal }),
            },
          };
        }
        if (body.outcome === 'target_rejected' || body.outcome === 'unavailable' || body.outcome === 'unknown'
          || body.outcome === 'unsupported') {
          return { status: 200, body };
        }
      }
      if (response.status === 400) {
        return { status: 400, body: INVALID_REQUEST };
      }
      return request.input.intent === undefined
        ? { status: 503, body: UNAVAILABLE }
        : { status: 200, body: { outcome: 'unknown' } };
    },
  };
}

function isRustSessionSendResponse(value: unknown, request: SessionSendRequest): value is RustSessionSendResponse {
  if (!isRecord(value) || typeof value.outcome !== 'string') return false;
  if (value.outcome === 'queued') {
    return request.input.intent === undefined
      && hasExactKeys(value, ['outcome', 'runId']) && typeof value.runId === 'string';
  }
  if (value.outcome === 'succeeded') {
    return hasAllowedKeys(value, ['outcome', 'runId', 'status'], ['goal'])
      && typeof value.runId === 'string'
      && (value.status === 'started' || value.status === 'in_flight' || value.status === 'ok')
      && isSessionSendGoalResponse(value, request);
  }
  return hasExactKeys(value, ['outcome'])
    && (value.outcome === 'target_rejected' || value.outcome === 'unavailable' || value.outcome === 'unknown'
      || (request.input.intent !== undefined && value.outcome === 'unsupported'));
}

export function isSessionSendGoalResponse(value: Record<string, unknown>, request: SessionSendRequest): boolean {
  if (request.input.intent === undefined) return !Object.hasOwn(value, 'goal');
  const receipt = decodeSessionGoalReceipt(value.goal);
  return receipt !== null && value.status === 'started'
    && receipt.action === 'start' && receipt.status === 'started'
    && receipt.operationId === request.input.idempotencyKey && receipt.runId === value.runId
    && (request.input.endpointSessionId === undefined || receipt.sessionId === request.input.endpointSessionId);
}

function isSessionSendRequest(value: unknown): value is SessionSendRequest {
  if (!isRecord(value)
    || !hasExactKeys(value, ['id', 'operationId', 'scope', 'target', 'input'])
    || value.id !== 'session.prompt'
    || value.operationId !== 'sessions.send'
    || !isSessionScope(value.scope)
    || !isRecord(value.target)
    || !hasExactKeys(value.target, ['kind', 'identity'])
    || value.target.kind !== 'session' || !isSessionIdentity(value.target.identity)
    || !isRecord(value.input)
    || !hasAllowedKeys(value.input, ['identity', 'message', 'attachments'], ['endpointSessionId', 'runId', 'idempotencyKey', 'deliver', 'intent'])
    || !isSessionIdentity(value.input.identity)
    || !sameSessionIdentity(value.scope.identity, value.input.identity)
    || !sameSessionIdentity(value.scope.identity, value.target.identity)
    || (value.input.endpointSessionId !== undefined
      && (typeof value.input.endpointSessionId !== 'string' || !value.input.endpointSessionId))
    || typeof value.input.message !== 'string'
    || (value.input.runId !== undefined
      && (typeof value.input.runId !== 'string' || !value.input.runId))
    || (value.input.idempotencyKey !== undefined
      && (typeof value.input.idempotencyKey !== 'string' || !value.input.idempotencyKey))
    || (value.input.deliver !== undefined && typeof value.input.deliver !== 'boolean')
    || (Object.hasOwn(value.input, 'intent') && (!isSessionSendIntent(value.input.intent)
      || value.input.runId !== undefined || !isGoalIdentifier(value.input.idempotencyKey, 128)
      || !isGoalObjective(value.input.message)))
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
  return true;
}

function isSessionScope(value: unknown): value is SessionSendRequest['scope'] {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'identity'])
    && value.kind === 'session'
    && isSessionIdentity(value.identity);
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
