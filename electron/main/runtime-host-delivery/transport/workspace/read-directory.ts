import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import {
  hasExactKeys,
  isNonEmptyBoundedText,
  isRecord,
  isSafeNonNegativeInteger,
  sendLoopbackJson,
} from '../client';

const ROUTE_PATH = '/api/workspace/files/list-dir';
const UNAVAILABLE = {
  success: false,
  error: 'Workspace directory is unavailable',
} as const;

type WorkspaceDirectoryRequest = Readonly<{
  id: 'workspace.file';
  operationId: 'files.listDir';
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
    includeHidden: boolean;
  }>;
}>;

type Endpoint = Readonly<{
  kind: 'native-runtime';
  runtimeAdapterId: 'openclaw';
  runtimeInstanceId: 'local';
}>;

export type WorkspaceDirectoryTransportResponse = Readonly<{
  status: 200 | 422 | 503;
  body: unknown;
}>;

export interface WorkspaceDirectoryTransport {
  list(request: unknown): Promise<WorkspaceDirectoryTransportResponse>;
}

export function createWorkspaceDirectoryTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): WorkspaceDirectoryTransport {
  return {
    async list(request: unknown): Promise<WorkspaceDirectoryTransportResponse> {
      if (!isWorkspaceDirectoryRequest(request)) {
        return { status: 503, body: UNAVAILABLE };
      }
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        path: ROUTE_PATH,
        issuer,
        decision: {
          endpoint: ROUTE_PATH,
          scope: 'workspace-files:list',
          capability: 'files.listDir',
          subject: 'workspace-directory',
        },
        method: 'POST',
        fetcher,
        body: request,
      });
      if (response?.status === 200 && isWorkspaceDirectoryResponse(response.body)) {
        return { status: 200, body: response.body };
      }
      if (response?.status === 422 && isPublicFailure(response.body)) {
        return { status: 422, body: response.body };
      }
      return { status: 503, body: UNAVAILABLE };
    },
  };
}

function isWorkspaceDirectoryRequest(value: unknown): value is WorkspaceDirectoryRequest {
  return isRecord(value)
    && hasExactKeys(value, ['id', 'operationId', 'scope', 'target', 'input'])
    && value.id === 'workspace.file'
    && value.operationId === 'files.listDir'
    && isScope(value.scope)
    && isTarget(value.target)
    && isInput(value.input)
    && value.scope.sessionKey === value.input.sessionKey;
}

function isScope(value: unknown): value is WorkspaceDirectoryRequest['scope'] {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'endpoint', 'sessionKey'])
    && value.kind === 'session'
    && isEndpoint(value.endpoint)
    && isNonEmptyBoundedText(value.sessionKey);
}

function isTarget(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['kind']) && value.kind === 'workspace-file';
}

function isInput(value: unknown): value is WorkspaceDirectoryRequest['input'] {
  return isRecord(value)
    && hasExactKeys(value, ['endpoint', 'sessionKey', 'relativePath', 'includeHidden'])
    && isEndpoint(value.endpoint)
    && isNonEmptyBoundedText(value.sessionKey)
    && isDirectoryRelativePath(value.relativePath)
    && typeof value.includeHidden === 'boolean';
}

function isDirectoryRelativePath(value: unknown): value is string {
  return (value === '' || isNonEmptyBoundedText(value))
    && !value.startsWith('/')
    && !value.startsWith('\\')
    && !value.includes(':')
    && (value === '' || value.split(/[\\/]/).every((component) => component !== '' && component !== '.' && component !== '..'));
}

function isEndpoint(value: unknown): value is Endpoint {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'runtimeAdapterId', 'runtimeInstanceId'])
    && value.kind === 'native-runtime'
    && value.runtimeAdapterId === 'openclaw'
    && value.runtimeInstanceId === 'local';
}

function isWorkspaceDirectoryResponse(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['entries'])
    && Array.isArray(value.entries)
    && value.entries.every(isWorkspaceDirectoryEntry);
}

function isWorkspaceDirectoryEntry(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['relativePath', 'display', 'isDirectory', 'size'])
    && isNonEmptyBoundedText(value.relativePath)
    && isNonEmptyBoundedText(value.display)
    && typeof value.isDirectory === 'boolean'
    && isSafeNonNegativeInteger(value.size);
}

function isPublicFailure(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['success', 'error'])
    && value.success === false
    && [
      'Workspace directory path is invalid',
      'Workspace directory target is not a directory',
    ].includes(value.error as string);
}
