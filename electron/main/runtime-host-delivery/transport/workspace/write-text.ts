import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import {
  hasExactKeys,
  isNonEmptyBoundedText,
  isRecord,
  isSafeNonNegativeInteger,
  sendLoopbackJson,
} from '../client';

const MAX_CONTENT_BYTES = 2 * 1024 * 1024;
const ROUTE_PATH = '/api/workspace/files/write-text';
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
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): WorkspaceWriteTransport {
  return {
    async write(request: unknown): Promise<WorkspaceWriteTransportResponse> {
      if (!isWorkspaceWriteRequest(request)) {
        return { status: 503, body: UNAVAILABLE };
      }
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        path: ROUTE_PATH,
        issuer,
        decision: {
          endpoint: ROUTE_PATH,
          scope: 'workspace-files:write',
          capability: 'files.writeText',
          subject: 'workspace-write',
        },
        method: 'POST',
        fetcher,
        body: request,
      });
      if (response?.status === 200 && isWorkspaceWriteResponse(response.body)) {
        return { status: 200, body: response.body };
      }
      if (response?.status === 422 && isPublicFailure(response.body)) {
        return { status: 422, body: response.body };
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
    && isNonEmptyBoundedText(value.sessionKey);
}

function isTarget(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['kind']) && value.kind === 'workspace-file';
}

function isInput(value: unknown): value is WorkspaceWriteRequest['input'] {
  return isRecord(value)
    && hasExactKeys(value, ['endpoint', 'sessionKey', 'relativePath', 'content'])
    && isEndpoint(value.endpoint)
    && isNonEmptyBoundedText(value.sessionKey)
    && isFileRelativePath(value.relativePath)
    && typeof value.content === 'string'
    && Buffer.byteLength(value.content, 'utf8') <= MAX_CONTENT_BYTES;
}

function isFileRelativePath(value: unknown): value is string {
  return isNonEmptyBoundedText(value)
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
    && isNonEmptyBoundedText(value.name)
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
