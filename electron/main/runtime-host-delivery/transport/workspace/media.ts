import type { RuntimeHostDeliveryIssuer } from '../../bootstrap';

const DECISION_TTL_MS = 30_000;
const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
const MAX_PATHS = 256;
const UNAVAILABLE = { success: false, error: 'Workspace media is unavailable' } as const;

export type WorkspaceMediaOperationId =
  | 'media.prepare'
  | 'media.resolve'
  | 'media.thumbnail'
  | 'media.thumbnails'
  | 'media.stagePaths'
  | 'media.stageBuffer';

export interface WorkspaceMediaTransport {
  execute(request: unknown): Promise<{ status: 200 | 422 | 503; body: unknown }>;
}

export function createWorkspaceMediaTransport(
  issuer: RuntimeHostDeliveryIssuer,
  port: number,
  fetcher: typeof fetch = fetch,
): WorkspaceMediaTransport {
  return {
    async execute(request: unknown) {
      if (!isRequest(request)) return { status: 503, body: UNAVAILABLE };
      try {
        const response = await fetcher(`http://127.0.0.1:${port}/api/workspace/media`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${issuer.signDecision({
              principal: 'electron-main-local',
              endpoint: '/api/workspace/media',
              scope: 'workspace-media:read',
              capability: request.operationId,
              subject: 'workspace-media',
              expiresAt: Date.now() + DECISION_TTL_MS,
              revision: '1',
            })}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(request),
        });
        const body: unknown = await response.json();
        if (response.status === 200 && isResponse(body, request.operationId)) {
          return { status: 200, body };
        }
        if (response.status === 422 && isFailure(body)) return { status: 422, body };
      } catch {
        // Keep loopback transport details private.
      }
      return { status: 503, body: UNAVAILABLE };
    },
  };
}

export type WorkspaceMediaPath = Readonly<{
  key: string;
  relativePath: string;
  mimeType: string;
}> | Readonly<{
  key: string;
  gatewayUrl: string;
  mimeType: string;
  agentId: string;
}>;

type Endpoint = {
  kind: 'native-runtime';
  runtimeAdapterId: 'openclaw';
  runtimeInstanceId: 'local';
};
type Request = {
  id: 'workspace.media';
  operationId: WorkspaceMediaOperationId;
  scope: { kind: 'session'; endpoint: Endpoint; sessionKey: string };
  target: { kind: 'workspace-media' };
  input: {
    endpoint: Endpoint;
    sessionKey: string;
    relativePath?: string;
    mimeType?: string;
    reference?: string;
    paths?: readonly WorkspaceMediaPath[];
    base64?: string;
    fileName?: string;
  };
};

type MediaReceipt = Readonly<{
  reference: string;
  name: string;
  mimeType: string;
  size: number;
  preview: string | null;
}>;

type Thumbnail = Readonly<{ preview: string | null; fileSize: number }>;

function isRequest(value: unknown): value is Request {
  if (!isRecord(value)
    || !exact(value, ['id', 'operationId', 'scope', 'target', 'input'])
    || value.id !== 'workspace.media'
    || !isOperationId(value.operationId)
    || !isScope(value.scope)
    || !isRecord(value.target)
    || !exact(value.target, ['kind'])
    || value.target.kind !== 'workspace-media'
    || !isRecord(value.input)) {
    return false;
  }

  const input = value.input;
  if (!isEndpoint(input.endpoint) || input.sessionKey !== value.scope.sessionKey) return false;
  switch (value.operationId) {
    case 'media.prepare':
      return exact(input, ['endpoint', 'sessionKey', 'relativePath', 'mimeType'])
        && isRelativePath(input.relativePath)
        && isMimeType(input.mimeType);
    case 'media.thumbnail':
      return (exact(input, ['endpoint', 'sessionKey', 'relativePath', 'mimeType'])
        && isRelativePath(input.relativePath)
        && isMimeType(input.mimeType))
        || (exact(input, ['endpoint', 'sessionKey', 'gatewayUrl', 'mimeType', 'agentId'])
          && isGatewayUrl(input.gatewayUrl)
          && isMimeType(input.mimeType)
          && isIdentifier(input.agentId));
    case 'media.resolve':
      return exact(input, ['endpoint', 'sessionKey', 'reference']) && isReference(input.reference);
    case 'media.thumbnails':
      return exact(input, ['endpoint', 'sessionKey', 'paths'])
        && Array.isArray(input.paths)
        && input.paths.length <= MAX_PATHS
        && input.paths.every(isMediaPath);
    case 'media.stagePaths':
      return exact(input, ['endpoint', 'sessionKey', 'paths'])
        && Array.isArray(input.paths)
        && input.paths.length <= MAX_PATHS
        && input.paths.every(isRelativeMediaPath);
    case 'media.stageBuffer':
      return exact(input, ['endpoint', 'sessionKey', 'base64', 'fileName', 'mimeType'])
        && typeof input.base64 === 'string'
        && input.base64.length > 0
        && isCanonicalBase64(input.base64)
        && isSafeFileName(input.fileName)
        && isMimeType(input.mimeType)
        && estimateBase64Bytes(input.base64) <= MAX_MEDIA_BYTES;
  }
}

function isResponse(value: unknown, operation: WorkspaceMediaOperationId): boolean {
  if (operation === 'media.resolve') {
    return isRecord(value) && exact(value, ['data']) && isCanonicalBase64(value.data);
  }
  if (operation === 'media.thumbnail') {
    return isThumbnail(value);
  }
  if (operation === 'media.thumbnails') {
    return isRecord(value)
      && Object.keys(value).length <= MAX_PATHS
      && Object.values(value).every(isThumbnail);
  }
  if (operation === 'media.stagePaths') {
    return Array.isArray(value) && value.every(isMediaReceipt);
  }
  return isMediaReceipt(value);
}

function isMediaPath(value: unknown): value is WorkspaceMediaPath {
  return isRecord(value)
    && isNonEmptyString(value.key)
    && ((exact(value, ['key', 'relativePath', 'mimeType'])
      && isRelativePath(value.relativePath)
      && isMimeType(value.mimeType))
      || (exact(value, ['key', 'gatewayUrl', 'mimeType', 'agentId'])
        && isGatewayUrl(value.gatewayUrl)
        && isMimeType(value.mimeType)
        && isIdentifier(value.agentId)));
}

function isRelativeMediaPath(value: unknown): value is Extract<WorkspaceMediaPath, { relativePath: string }> {
  return isRecord(value)
    && isNonEmptyString(value.key)
    && exact(value, ['key', 'relativePath', 'mimeType'])
    && isRelativePath(value.relativePath)
    && isMimeType(value.mimeType);
}

function isMediaReceipt(value: unknown): value is MediaReceipt {
  return isRecord(value)
    && exact(value, ['reference', 'name', 'mimeType', 'size', 'preview'])
    && isReference(value.reference)
    && isSafeFileName(value.name)
    && isMimeType(value.mimeType)
    && Number.isSafeInteger(value.size)
    && value.size >= 0
    && value.size <= MAX_MEDIA_BYTES
    && (typeof value.preview === 'string' || value.preview === null);
}

function isThumbnail(value: unknown): value is Thumbnail {
  return isRecord(value)
    && exact(value, ['preview', 'fileSize'])
    && (typeof value.preview === 'string' || value.preview === null)
    && Number.isSafeInteger(value.fileSize)
    && value.fileSize >= 0
    && value.fileSize <= MAX_MEDIA_BYTES;
}

function isFailure(value: unknown): boolean {
  return isRecord(value)
    && exact(value, ['success', 'error'])
    && value.success === false
    && typeof value.error === 'string';
}

function isOperationId(value: unknown): value is WorkspaceMediaOperationId {
  return value === 'media.prepare'
    || value === 'media.resolve'
    || value === 'media.thumbnail'
    || value === 'media.thumbnails'
    || value === 'media.stagePaths'
    || value === 'media.stageBuffer';
}

function isScope(value: unknown): value is Request['scope'] {
  return isRecord(value)
    && exact(value, ['kind', 'endpoint', 'sessionKey'])
    && value.kind === 'session'
    && isEndpoint(value.endpoint)
    && isNonEmptyString(value.sessionKey);
}

function isEndpoint(value: unknown): value is Endpoint {
  return isRecord(value)
    && exact(value, ['kind', 'runtimeAdapterId', 'runtimeInstanceId'])
    && value.kind === 'native-runtime'
    && value.runtimeAdapterId === 'openclaw'
    && value.runtimeInstanceId === 'local';
}

function isRelativePath(value: unknown): value is string {
  return isNonEmptyString(value)
    && !value.startsWith('/')
    && !value.startsWith('\\')
    && !value.includes(':')
    && value.split(/[\\/]/).every((part) => part !== '' && part !== '.' && part !== '..');
}

function isGatewayUrl(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 4096
    && !hasControlCharacter(value)
    && !value.includes('\\0')
    && /^\/?api\/chat\/media\/outgoing\/[^/]+\/[^/]+(?:\/[^/]*)?$/.test(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 4096
    && !hasControlCharacter(value)
    && !value.includes('\\0');
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
}

function isSafeFileName(value: unknown): value is string {
  return isNonEmptyString(value)
    && value !== '.'
    && value !== '..'
    && !value.includes('/')
    && !value.includes('\\')
    && ![...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127;
    });
}

function isMimeType(value: unknown): value is string {
  return isNonEmptyString(value) && value.length <= 255;
}

function isReference(value: unknown): value is string {
  return typeof value === 'string' && /^media_[a-f0-9]{32}$/.test(value);
}

function isCanonicalBase64(value: unknown): value is string {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  return Buffer.from(value, 'base64').toString('base64') === value;
}

function estimateBase64Bytes(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return Math.max(0, (value.length * 3) / 4 - padding);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
