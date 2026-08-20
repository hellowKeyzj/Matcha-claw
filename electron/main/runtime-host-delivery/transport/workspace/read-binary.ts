import type { RuntimeHostDeliveryIssuer } from '../../bootstrap';

const DECISION_TTL_MS = 30_000;
const MAX_BINARY_BYTES = 50 * 1024 * 1024;
const UNAVAILABLE = {
  success: false,
  error: 'Workspace binary is unavailable',
} as const;

type Endpoint = Readonly<{
  kind: 'native-runtime';
  runtimeAdapterId: 'openclaw';
  runtimeInstanceId: 'local';
}>;

type WorkspaceBinaryRequest = Readonly<{
  id: 'workspace.file';
  operationId: 'files.readBinary' | 'files.stat';
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
  port: number,
  fetcher: typeof fetch = fetch,
): WorkspaceBinaryTransport {
  const url = `http://127.0.0.1:${port}/api/workspace/files/binary`;
  return {
    async execute(request: unknown): Promise<WorkspaceBinaryTransportResponse> {
      if (!isWorkspaceBinaryRequest(request)) {
        return { status: 503, body: UNAVAILABLE };
      }
      try {
        const forwardedRequest = withBoundedMaxBytes(request);
        const response = await fetcher(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${issuer.signDecision({
              principal: 'electron-main-local',
              endpoint: '/api/workspace/files/binary',
              scope: 'workspace-files:binary',
              capability: request.operationId,
              subject: 'workspace-binary',
              expiresAt: Date.now() + DECISION_TTL_MS,
              revision: '1',
            })}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(forwardedRequest),
        });
        const body: unknown = await response.json();
        if (response.status === 200 && isWorkspaceBinaryResponse(body, request.operationId)) {
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

function isWorkspaceBinaryRequest(value: unknown): value is WorkspaceBinaryRequest {
  return isRecord(value)
    && hasExactKeys(value, ['id', 'operationId', 'scope', 'target', 'input'])
    && value.id === 'workspace.file'
    && (value.operationId === 'files.readBinary' || value.operationId === 'files.stat')
    && isScope(value.scope)
    && isTarget(value.target)
    && isInput(value.input, value.operationId)
    && value.scope.sessionKey === value.input.sessionKey;
}

function isScope(value: unknown): value is WorkspaceBinaryRequest['scope'] {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'endpoint', 'sessionKey'])
    && value.kind === 'session'
    && isEndpoint(value.endpoint)
    && isNonEmptyString(value.sessionKey);
}

function isTarget(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['kind']) && value.kind === 'workspace-file';
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
    ? hasExactKeys(value, ['endpoint', 'sessionKey', 'relativePath'])
      || hasExactKeys(value, ['endpoint', 'sessionKey', 'relativePath', 'maxBytes'])
    : hasExactKeys(value, ['endpoint', 'sessionKey', 'relativePath']);
  return hasRequiredFields
    && isEndpoint(value.endpoint)
    && isNonEmptyString(value.sessionKey)
    && isRelativePath(value.relativePath)
    && (operationId === 'files.stat' || value.maxBytes === undefined || isSafeInteger(value.maxBytes));
}

function isRelativePath(value: unknown): value is string {
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

function isWorkspaceBinaryResponse(
  value: unknown,
  operationId: WorkspaceBinaryRequest['operationId'],
): boolean {
  return operationId === 'files.readBinary'
    ? isRecord(value)
      && hasExactKeys(value, ['name', 'data', 'size'])
      && isNonEmptyString(value.name)
      && typeof value.data === 'string'
      && isSafeNonNegativeInteger(value.size)
    : isRecord(value)
      && hasExactKeys(value, ['name', 'isDirectory', 'size', 'mtimeMs'])
      && isNonEmptyString(value.name)
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0');
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
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
