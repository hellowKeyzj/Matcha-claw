import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import {
  hasExactKeys,
  isNonEmptyBoundedText,
  isRecord,
  isSafeInteger,
  isSafeNonNegativeInteger,
  sendLoopbackJson,
} from '../client';

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const ROUTE_PATH = '/api/workspace/files/read-text';
const UNAVAILABLE = {
  success: false,
  error: 'Workspace text is unavailable',
} as const;

type WorkspaceTextRequest = Readonly<{
  id: 'workspace.file';
  operationId: 'files.readText';
  scope: Readonly<{
    kind: 'session';
    endpoint: Readonly<{
      kind: 'native-runtime';
      runtimeAdapterId: 'openclaw';
      runtimeInstanceId: 'local';
    }>;
    sessionKey: string;
  }>;
  target: Readonly<{ kind: 'workspace-file' }>;
  input: Readonly<{
    endpoint: Readonly<{
      kind: 'native-runtime';
      runtimeAdapterId: 'openclaw';
      runtimeInstanceId: 'local';
    }>;
    sessionKey: string;
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
    && isScope(value.scope)
    && isTarget(value.target)
    && isInput(value.input)
    && value.scope.sessionKey === value.input.sessionKey;
}

function isScope(value: unknown): value is WorkspaceTextRequest['scope'] {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'endpoint', 'sessionKey'])
    && value.kind === 'session'
    && isEndpoint(value.endpoint)
    && isNonEmptyBoundedText(value.sessionKey);
}

function isTarget(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['kind']) && value.kind === 'workspace-file';
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
  const hasRequiredFields = hasExactKeys(value, ['endpoint', 'sessionKey', 'relativePath'])
    || hasExactKeys(value, ['endpoint', 'sessionKey', 'relativePath', 'maxBytes']);
  return hasRequiredFields
    && isEndpoint(value.endpoint)
    && isNonEmptyBoundedText(value.sessionKey)
    && isRelativePath(value.relativePath)
    && (value.maxBytes === undefined || isSafeInteger(value.maxBytes));
}

function isRelativePath(value: unknown): value is string {
  return isNonEmptyBoundedText(value)
    && !value.startsWith('/')
    && !value.startsWith('\\')
    && !value.includes(':')
    && value.split(/[\\/]/).every((component) => component !== '' && component !== '.' && component !== '..');
}

function isEndpoint(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'runtimeAdapterId', 'runtimeInstanceId'])
    && value.kind === 'native-runtime'
    && value.runtimeAdapterId === 'openclaw'
    && value.runtimeInstanceId === 'local';
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
