import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import {
  hasExactKeys,
  isNonEmptyBoundedText,
  isRecord,
  isSafeNonNegativeInteger,
  sendLoopbackJson,
} from '../client';
import {
  type Endpoint,
  type FileTarget,
  type AgentScope,
  isEndpoint,
  isFileRelativePath,
  isFileTarget,
  isAgentScope,
} from './contract';

const ROUTE_PATH = '/api/workspace/files/list-dir';
const UNAVAILABLE = {
  success: false,
  error: 'Workspace directory is unavailable',
} as const;

type WorkspaceDirectoryRequest = Readonly<{
  id: 'workspace.file';
  operationId: 'files.listDir';
  scope: AgentScope;
  target: FileTarget;
  input: Readonly<{
    endpoint: Endpoint;
    agentId: string;
    relativePath: string;
    includeHidden: boolean;
  }>;
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
    && isAgentScope(value.scope)
    && isFileTarget(value.target)
    && isInput(value.input)
    && value.scope.agentId === value.input.agentId
    && value.scope.endpoint.runtimeAdapterId === value.input.endpoint.runtimeAdapterId
    && value.scope.endpoint.runtimeInstanceId === value.input.endpoint.runtimeInstanceId;
}

function isInput(value: unknown): value is WorkspaceDirectoryRequest['input'] {
  return isRecord(value)
    && hasExactKeys(value, ['endpoint', 'agentId', 'relativePath', 'includeHidden'])
    && isEndpoint(value.endpoint)
    && isNonEmptyBoundedText(value.agentId)
    && (value.relativePath === '' || isFileRelativePath(value.relativePath))
    && typeof value.includeHidden === 'boolean';
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
