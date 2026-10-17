import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import {
  hasExactKeys,
  isNonEmptyBoundedText,
  isRecord,
  isSafeInteger,
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

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const ROUTE_PATH = '/api/workspace/files/read-text';
const UNAVAILABLE = {
  success: false,
  error: 'Workspace text is unavailable',
} as const;

type WorkspaceTextRequest = Readonly<{
  id: 'workspace.file';
  operationId: 'files.readText';
  scope: AgentScope;
  target: FileTarget;
  input: Readonly<{
    endpoint: Endpoint;
    agentId: string;
    relativePath: string;
    maxBytes?: number;
  }>;
}>;

export type WorkspaceTextTransportResponse = Readonly<{
  status: 200 | 422 | 503;
  body: unknown;
}>;

export interface WorkspaceTextTransport {
  read(request: unknown): Promise<WorkspaceTextTransportResponse>;
}

export function createWorkspaceTextTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): WorkspaceTextTransport {
  return {
    async read(request: unknown): Promise<WorkspaceTextTransportResponse> {
      if (!isWorkspaceTextRequest(request)) {
        return { status: 503, body: UNAVAILABLE };
      }
      const forwardedRequest = withBoundedMaxBytes(request);
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        path: ROUTE_PATH,
        issuer,
        decision: {
          endpoint: ROUTE_PATH,
          scope: 'workspace-files:read',
          capability: 'files.readText',
          subject: 'workspace-text',
        },
        method: 'POST',
        fetcher,
        body: forwardedRequest,
      });
      if (response?.status === 200 && isWorkspaceTextResponse(response.body)) {
        return { status: 200, body: response.body };
      }
      if (response?.status === 422 && isPublicFailure(response.body)) {
        return { status: 422, body: response.body };
      }
      return { status: 503, body: UNAVAILABLE };
    },
  };
}

function isWorkspaceTextRequest(value: unknown): value is WorkspaceTextRequest {
  return isRecord(value)
    && hasExactKeys(value, ['id', 'operationId', 'scope', 'target', 'input'])
    && value.id === 'workspace.file'
    && value.operationId === 'files.readText'
    && isAgentScope(value.scope)
    && isFileTarget(value.target)
    && isInput(value.input)
    && value.scope.agentId === value.input.agentId
    && value.scope.endpoint.runtimeAdapterId === value.input.endpoint.runtimeAdapterId
    && value.scope.endpoint.runtimeInstanceId === value.input.endpoint.runtimeInstanceId;
}

function withBoundedMaxBytes(request: WorkspaceTextRequest): WorkspaceTextRequest {
  if (request.input.maxBytes === undefined) {
    return request;
  }
  return {
    ...request,
    input: {
      ...request.input,
      maxBytes: Math.max(1, Math.min(Math.floor(request.input.maxBytes), MAX_TEXT_BYTES)),
    },
  };
}

function isInput(value: unknown): value is WorkspaceTextRequest['input'] {
  if (!isRecord(value)) {
    return false;
  }
  const hasRequiredFields = hasExactKeys(value, ['endpoint', 'agentId', 'relativePath'])
    || hasExactKeys(value, ['endpoint', 'agentId', 'relativePath', 'maxBytes']);
  return hasRequiredFields
    && isEndpoint(value.endpoint)
    && isNonEmptyBoundedText(value.agentId)
    && isFileRelativePath(value.relativePath)
    && (value.maxBytes === undefined || isSafeInteger(value.maxBytes));
}

function isWorkspaceTextResponse(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['name', 'content', 'size'])
    && isNonEmptyBoundedText(value.name)
    && typeof value.content === 'string'
    && isSafeNonNegativeInteger(value.size);
}

function isPublicFailure(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['success', 'error'])
    && value.success === false
    && [
      'Workspace text path is invalid',
      'Workspace text target is not a file',
      'Workspace text target exceeds the limit',
      'Workspace text target is binary',
    ].includes(value.error as string);
}
