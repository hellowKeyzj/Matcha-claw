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

const MAX_BINARY_BYTES = 50 * 1024 * 1024;
const ROUTE_PATH = '/api/workspace/files/binary';
const UNAVAILABLE = {
  success: false,
  error: 'Workspace binary is unavailable',
} as const;

type WorkspaceBinaryRequest = Readonly<{
  id: 'workspace.file';
  operationId: 'files.readBinary' | 'files.stat';
  scope: AgentScope;
  target: FileTarget;
  input: Readonly<{
    endpoint: Endpoint;
    agentId: string;
    relativePath: string;
    maxBytes?: number;
  }>;
}>;

export type WorkspaceBinaryTransportResponse = Readonly<{
  status: 200 | 422 | 503;
  body: unknown;
}>;

export interface WorkspaceBinaryTransport {
  execute(request: unknown): Promise<WorkspaceBinaryTransportResponse>;
}

export function createWorkspaceBinaryTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): WorkspaceBinaryTransport {
  return {
    async execute(request: unknown): Promise<WorkspaceBinaryTransportResponse> {
      if (!isWorkspaceBinaryRequest(request)) {
        return { status: 503, body: UNAVAILABLE };
      }
      const forwardedRequest = withBoundedMaxBytes(request);
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        path: ROUTE_PATH,
        issuer,
        decision: {
          endpoint: ROUTE_PATH,
          scope: 'workspace-files:binary',
          capability: request.operationId,
          subject: 'workspace-binary',
        },
        method: 'POST',
        fetcher,
        body: forwardedRequest,
      });
      if (response?.status === 200 && isWorkspaceBinaryResponse(response.body, request.operationId)) {
        return { status: 200, body: response.body };
      }
      if (response?.status === 422 && isPublicFailure(response.body)) {
        return { status: 422, body: response.body };
      }
      return { status: 503, body: UNAVAILABLE };
    },
  };
}

function isWorkspaceBinaryRequest(value: unknown): value is WorkspaceBinaryRequest {
  return isRecord(value)
    && hasExactKeys(value, ['id', 'operationId', 'scope', 'target', 'input'])
    && value.id === 'workspace.file'
    && (value.operationId === 'files.readBinary' || value.operationId === 'files.stat')
    && isAgentScope(value.scope)
    && isFileTarget(value.target)
    && isInput(value.input, value.operationId)
    && value.scope.agentId === value.input.agentId
    && value.scope.endpoint.runtimeAdapterId === value.input.endpoint.runtimeAdapterId
    && value.scope.endpoint.runtimeInstanceId === value.input.endpoint.runtimeInstanceId;
}

function withBoundedMaxBytes(request: WorkspaceBinaryRequest): WorkspaceBinaryRequest {
  if (request.operationId === 'files.stat' || request.input.maxBytes === undefined) {
    return request;
  }
  return {
    ...request,
    input: {
      ...request.input,
      maxBytes: Math.max(1, Math.min(Math.floor(request.input.maxBytes), MAX_BINARY_BYTES)),
    },
  };
}

function isInput(
  value: unknown,
  operationId: WorkspaceBinaryRequest['operationId'],
): value is WorkspaceBinaryRequest['input'] {
  if (!isRecord(value)) {
    return false;
  }
  const hasRequiredFields = operationId === 'files.readBinary'
    ? hasExactKeys(value, ['endpoint', 'agentId', 'relativePath'])
      || hasExactKeys(value, ['endpoint', 'agentId', 'relativePath', 'maxBytes'])
    : hasExactKeys(value, ['endpoint', 'agentId', 'relativePath']);
  return hasRequiredFields
    && isEndpoint(value.endpoint)
    && isNonEmptyBoundedText(value.agentId)
    && isFileRelativePath(value.relativePath)
    && (operationId === 'files.stat' || value.maxBytes === undefined || isSafeInteger(value.maxBytes));
}

function isWorkspaceBinaryResponse(
  value: unknown,
  operationId: WorkspaceBinaryRequest['operationId'],
): boolean {
  return operationId === 'files.readBinary'
    ? isRecord(value)
      && hasExactKeys(value, ['name', 'data', 'size'])
      && isNonEmptyBoundedText(value.name)
      && typeof value.data === 'string'
      && isSafeNonNegativeInteger(value.size)
    : isRecord(value)
      && hasExactKeys(value, ['name', 'isDirectory', 'size', 'mtimeMs'])
      && isNonEmptyBoundedText(value.name)
      && typeof value.isDirectory === 'boolean'
      && isSafeNonNegativeInteger(value.size)
      && isSafeNonNegativeInteger(value.mtimeMs);
}

function isPublicFailure(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['success', 'error'])
    && value.success === false
    && [
      'Workspace binary path is invalid',
      'Workspace binary target is not a file',
      'Workspace binary target exceeds the limit',
    ].includes(value.error as string);
}
