import type { RuntimeHostDeliveryIssuer } from '../../bootstrap';

const DECISION_TTL_MS = 30_000;
const MAX_CONTENT_BYTES = 2 * 1024 * 1024;
const UNAVAILABLE = {
  success: false,
  error: 'Workspace write is unavailable',
} as const;

type WorkspaceWriteRequest = Readonly<{
  id: 'workspace.file';
  operationId: 'files.writeText';
  scope: Readonly<{
    kind: 'session';
    endpoint: Endpoint;
    sessionKey: string;
  }>;
  target: Readonly<{ kind: 'workspace-file' }>;
  input: Readonly<{
    endpoint: Endpoint;
    sessionKey: string;
    relativePath: string;
    content: string;
  }>;
}>;

type Endpoint = Readonly<{
  kind: 'native-runtime';
  runtimeAdapterId: 'openclaw';
  runtimeInstanceId: 'local';
}>;

export type WorkspaceWriteTransportResponse = Readonly<{
  status: 200 | 422 | 503;
  body: unknown;
}>;

export interface WorkspaceWriteTransport {
  write(request: unknown): Promise<WorkspaceWriteTransportResponse>;
}

export function createWorkspaceWriteTransport(
  issuer: RuntimeHostDeliveryIssuer,
  port: number,
  fetcher: typeof fetch = fetch,
): WorkspaceWriteTransport {
  const url = `http://127.0.0.1:${port}/api/workspace/files/write-text`;
  return {
    async write(request: unknown): Promise<WorkspaceWriteTransportResponse> {
      if (!isWorkspaceWriteRequest(request)) {
        return { status: 503, body: UNAVAILABLE };
      }
      try {
        const response = await fetcher(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${issuer.signDecision({
              principal: 'electron-main-local',
              endpoint: '/api/workspace/files/write-text',
              scope: 'workspace-files:write',
              capability: 'files.writeText',
              subject: 'workspace-write',
              expiresAt: Date.now() + DECISION_TTL_MS,
              revision: '1',
            })}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(request),
        });
        const body: unknown = await response.json();
        if (response.status === 200 && isWorkspaceWriteResponse(body)) {
          return { status: 200, body };
        }
        if (response.status === 422 && isPublicFailure(body)) {
          return { status: 422, body };
        }
      } catch {
        // The public contract deliberately suppresses transport details.
      }
      return { status: 503, body: UNAVAILABLE };
    },
  };
}

function isWorkspaceWriteRequest(value: unknown): value is WorkspaceWriteRequest {
  return isRecord(value)
    && hasExactKeys(value, ['id', 'operationId', 'scope', 'target', 'input'])
    && value.id === 'workspace.file'
    && value.operationId === 'files.writeText'
    && isScope(value.scope)
    && isTarget(value.target)
    && isInput(value.input)
    && value.scope.sessionKey === value.input.sessionKey;
}

function isScope(value: unknown): value is WorkspaceWriteRequest['scope'] {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'endpoint', 'sessionKey'])
    && value.kind === 'session'
    && isEndpoint(value.endpoint)
    && isNonEmptyString(value.sessionKey);
}

function isTarget(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['kind']) && value.kind === 'workspace-file';
}

function isInput(value: unknown): value is WorkspaceWriteRequest['input'] {
  return isRecord(value)
    && hasExactKeys(value, ['endpoint', 'sessionKey', 'relativePath', 'content'])
    && isEndpoint(value.endpoint)
    && isNonEmptyString(value.sessionKey)
    && isFileRelativePath(value.relativePath)
    && typeof value.content === 'string'
    && Buffer.byteLength(value.content, 'utf8') <= MAX_CONTENT_BYTES;
}

function isFileRelativePath(value: unknown): value is string {
  return isNonEmptyString(value)
    && !value.startsWith('/')
    && !value.startsWith('\\')
    && !value.includes(':')
    && value.split(/[\\/]/).every((component) => component !== '' && component !== '.' && component !== '..');
}

function isEndpoint(value: unknown): value is Endpoint {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'runtimeAdapterId', 'runtimeInstanceId'])
    && value.kind === 'native-runtime'
    && value.runtimeAdapterId === 'openclaw'
    && value.runtimeInstanceId === 'local';
}

function isWorkspaceWriteResponse(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['name', 'size'])
    && isNonEmptyString(value.name)
    && isSafeNonNegativeInteger(value.size);
}

function isPublicFailure(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['success', 'error'])
    && value.success === false
    && [
      'Workspace write path is invalid',
      'Workspace write target is not a file',
      'Workspace write content exceeds the limit',
      'Workspace write outcome is unknown',
    ].includes(value.error as string);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0');
}

function isSafeNonNegativeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
