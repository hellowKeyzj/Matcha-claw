import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import {
  hasExactKeys,
  isNonEmptyBoundedText,
  isRecord,
  isSafeNonNegativeInteger,
  sendLoopbackJsonDelivery,
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
const ROUTE_PATH = '/api/workspace/files/write-binary';
const UNAVAILABLE = {
  success: false,
  error: 'Workspace write is unavailable',
} as const;
const OUTCOME_UNKNOWN = {
  success: false,
  error: 'Workspace write outcome is unknown',
} as const;

type WorkspaceWriteBinaryRequest = Readonly<{
  id: 'workspace.file';
  operationId: 'files.writeBinary';
  scope: AgentScope;
  target: FileTarget;
  input: Readonly<{
    endpoint: Endpoint;
    agentId: string;
    relativePath: string;
    data: string;
  }>;
}>;

export type WorkspaceWriteBinaryTransportResponse = Readonly<{
  status: 200 | 422 | 503;
  body: unknown;
}>;

export interface WorkspaceWriteBinaryTransport {
  write(request: unknown): Promise<WorkspaceWriteBinaryTransportResponse>;
}

export function createWorkspaceWriteBinaryTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): WorkspaceWriteBinaryTransport {
  return {
    async write(request: unknown): Promise<WorkspaceWriteBinaryTransportResponse> {
      if (!isWorkspaceWriteBinaryRequest(request)) {
        return { status: 503, body: UNAVAILABLE };
      }
      const delivery = await sendLoopbackJsonDelivery({
        port: runtimeHostTransportPort,
        path: ROUTE_PATH,
        issuer,
        decision: {
          endpoint: ROUTE_PATH,
          scope: 'workspace-files:write',
          capability: 'files.writeBinary',
          subject: 'workspace-write',
        },
        method: 'POST',
        fetcher,
        body: request,
      });
      if (delivery.outcome === 'not-attempted') {
        return { status: 503, body: UNAVAILABLE };
      }
      if (delivery.outcome === 'response') {
        const response = delivery.response;
        if (response.status === 200 && isWorkspaceWriteResponse(response.body)) {
          return { status: 200, body: response.body };
        }
        if (response.status === 422 && isPublicFailure(response.body)) {
          return { status: 422, body: response.body };
        }
        if ([400, 401, 404, 413].includes(response.status)
          || (response.status === 503 && isRecord(response.body)
            && hasExactKeys(response.body, ['success', 'error'])
            && response.body.success === false && response.body.error === UNAVAILABLE.error)) {
          return { status: 503, body: UNAVAILABLE };
        }
      }
      return { status: 422, body: OUTCOME_UNKNOWN };
    },
  };
}

function isWorkspaceWriteBinaryRequest(value: unknown): value is WorkspaceWriteBinaryRequest {
  return isRecord(value)
    && hasExactKeys(value, ['id', 'operationId', 'scope', 'target', 'input'])
    && value.id === 'workspace.file'
    && value.operationId === 'files.writeBinary'
    && isAgentScope(value.scope)
    && isFileTarget(value.target)
    && isInput(value.input)
    && value.scope.agentId === value.input.agentId
    && value.scope.endpoint.runtimeAdapterId === value.input.endpoint.runtimeAdapterId
    && value.scope.endpoint.runtimeInstanceId === value.input.endpoint.runtimeInstanceId;
}

function isInput(value: unknown): value is WorkspaceWriteBinaryRequest['input'] {
  return isRecord(value)
    && hasExactKeys(value, ['endpoint', 'agentId', 'relativePath', 'data'])
    && isEndpoint(value.endpoint)
    && isNonEmptyBoundedText(value.agentId)
    && isFileRelativePath(value.relativePath)
    && isBinaryData(value.data);
}

function isBinaryData(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_BINARY_BYTES / 3) * 4
    || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  if ((value.length / 4) * 3 - padding > MAX_BINARY_BYTES) return false;
  if (value.length === 0) return true;
  const terminal = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    .indexOf(value.charAt(value.length - padding - 1));
  return terminal >= 0 && terminal % (padding === 0 ? 1 : padding === 1 ? 4 : 16) === 0;
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
