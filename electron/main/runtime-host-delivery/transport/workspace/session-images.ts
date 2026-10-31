import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { hasExactKeys, isNonEmptyBoundedText, isRecord, sendLoopbackJson } from '../client';
import { type Endpoint, type SessionScope, isEndpoint, isSessionScope } from './contract';

const ROUTE_PATH = '/api/workspace/session-images';
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const UNAVAILABLE = { success: false, error: 'Session images are unavailable' } as const;
const FAILURE_MESSAGES = {
  unsupported: 'Session images are unsupported',
  cursorInvalid: 'Session image cursor is invalid',
  invalidReference: 'Session image reference is invalid',
  tooLarge: 'Session image exceeds the limit',
} as const;

type Operation = 'media.listSessionImages' | 'media.readSessionImage';
type SessionImagesRequest = Readonly<{
  id: 'workspace.media';
  operationId: Operation;
  scope: SessionScope;
  target: Readonly<{ kind: 'workspace-media' }>;
  input: Readonly<{
    endpoint: Endpoint;
    sessionKey: string;
    agentId: string;
    cursor?: string;
    reference?: string;
  }>;
}>;

export interface WorkspaceSessionImagesTransport {
  execute(request: unknown): Promise<{ status: 200 | 422 | 503; body: unknown }>;
}

export function createWorkspaceSessionImagesTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): WorkspaceSessionImagesTransport {
  return {
    async execute(request: unknown) {
      if (!isRequest(request)) return { status: 503, body: UNAVAILABLE };
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        path: ROUTE_PATH,
        issuer,
        decision: {
          endpoint: ROUTE_PATH,
          scope: 'workspace-media:read',
          capability: request.operationId,
          subject: 'workspace-media',
        },
        method: 'POST',
        fetcher,
        body: request,
      });
      if (response?.status === 200 && isResponse(response.body, request.operationId)) {
        return { status: 200, body: response.body };
      }
      if (response?.status === 422 && isFailure(response.body)) {
        return { status: 422, body: response.body };
      }
      return { status: 503, body: UNAVAILABLE };
    },
  };
}

function isRequest(value: unknown): value is SessionImagesRequest {
  if (!isRecord(value)
    || !hasExactKeys(value, ['id', 'operationId', 'scope', 'target', 'input'])
    || value.id !== 'workspace.media'
    || (value.operationId !== 'media.listSessionImages' && value.operationId !== 'media.readSessionImage')
    || !isSessionScope(value.scope)
    || !isRecord(value.target) || !hasExactKeys(value.target, ['kind'])
    || value.target.kind !== 'workspace-media'
    || !isRecord(value.input)) return false;
  const input = value.input;
  return isEndpoint(input.endpoint)
    && isNonEmptyBoundedText(input.agentId) && input.agentId.trim().length > 0
    && input.sessionKey === value.scope.sessionKey
    && input.endpoint.runtimeAdapterId === value.scope.endpoint.runtimeAdapterId
    && input.endpoint.runtimeInstanceId === value.scope.endpoint.runtimeInstanceId
    && (value.operationId === 'media.listSessionImages'
      ? hasExactKeys(input, ['endpoint', 'sessionKey', 'agentId'])
        || (hasExactKeys(input, ['endpoint', 'sessionKey', 'agentId', 'cursor'])
          && isNonEmptyBoundedText(input.cursor, 256))
      : hasExactKeys(input, ['endpoint', 'sessionKey', 'agentId', 'reference'])
        && isNonEmptyBoundedText(input.reference, 8192));
}

function isResponse(value: unknown, operation: Operation): boolean {
  if (!isRecord(value)) return false;
  return operation === 'media.listSessionImages'
    ? (hasExactKeys(value, ['items', 'omittedOversized'])
      || (hasExactKeys(value, ['items', 'nextCursor', 'omittedOversized'])
        && isNonEmptyBoundedText(value.nextCursor, 256)))
      && Array.isArray(value.items) && value.items.length <= 4 && value.items.every(isImage)
      && typeof value.omittedOversized === 'boolean'
    : hasExactKeys(value, ['name', 'mimeType', 'data'])
      && isName(value.name) && isImageMimeType(value.mimeType) && isImageData(value.data);
}

function isImage(value: unknown): boolean {
  return isRecord(value)
    && (hasExactKeys(value, ['reference', 'name', 'readable'])
      || (hasExactKeys(value, ['reference', 'name', 'mimeType', 'readable'])
        && isNonEmptyBoundedText(value.mimeType, 255)))
    && isNonEmptyBoundedText(value.reference, 8192)
    && isName(value.name) && typeof value.readable === 'boolean';
}

function isName(value: unknown): value is string {
  return isNonEmptyBoundedText(value) && value !== '.' && value !== '..'
    && !value.includes('/') && !value.includes('\\') && !value.includes(':')
    && ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    });
}

function isImageMimeType(value: unknown): value is string {
  return isNonEmptyBoundedText(value, 255) && /^image\/[A-Za-z0-9.+-]+$/.test(value);
}

function isImageData(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4
    || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  if ((value.length / 4) * 3 - padding > MAX_IMAGE_BYTES) return false;
  if (value.length === 0) return true;
  const terminal = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    .indexOf(value.charAt(value.length - padding - 1));
  return terminal >= 0 && terminal % (padding === 0 ? 1 : padding === 1 ? 4 : 16) === 0;
}

function isFailure(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['success', 'code', 'error'])
    && value.success === false && typeof value.code === 'string'
    && Object.hasOwn(FAILURE_MESSAGES, value.code)
    && value.error === FAILURE_MESSAGES[value.code as keyof typeof FAILURE_MESSAGES];
}
