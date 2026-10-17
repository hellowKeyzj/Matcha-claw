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

const MAX_CONTENT_BYTES = 2 * 1024 * 1024;
const ROUTE_PATH = '/api/workspace/files/write-text';
const UNAVAILABLE = {
  success: false,
  error: 'Workspace write is unavailable',
} as const;

type WorkspaceWriteRequest = Readonly<{
  id: 'workspace.file';
  operationId: 'files.writeText';
  scope: AgentScope;
  target: FileTarget;
  input: Readonly<{
    endpoint: Endpoint;
    agentId: string;
    relativePath: string;
    content: string;
  }>;
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
    && isAgentScope(value.scope)
    && isFileTarget(value.target)
    && isInput(value.input)
    && value.scope.agentId === value.input.agentId
    && value.scope.endpoint.runtimeAdapterId === value.input.endpoint.runtimeAdapterId
    && value.scope.endpoint.runtimeInstanceId === value.input.endpoint.runtimeInstanceId;
}

function isInput(value: unknown): value is WorkspaceWriteRequest['input'] {
  return isRecord(value)
    && hasExactKeys(value, ['endpoint', 'agentId', 'relativePath', 'content'])
    && isEndpoint(value.endpoint)
    && isNonEmptyBoundedText(value.agentId)
    && isFileRelativePath(value.relativePath)
    && typeof value.content === 'string'
    && Buffer.byteLength(value.content, 'utf8') <= MAX_CONTENT_BYTES;
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
