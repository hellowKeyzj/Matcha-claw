import type { RuntimeHostDeliveryIssuer } from '../../bootstrap';

const DECISION_TTL_MS = 30_000;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
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
  port: number,
  fetcher: typeof fetch = fetch,
): WorkspaceTextTransport {
  const url = `http://127.0.0.1:${port}/api/workspace/files/read-text`;
  return {
    async read(request: unknown): Promise<WorkspaceTextTransportResponse> {
      if (!isWorkspaceTextRequest(request)) {
        return { status: 503, body: UNAVAILABLE };
      }
      try {
        const forwardedRequest = withBoundedMaxBytes(request);
        const response = await fetcher(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${issuer.signDecision({
              principal: 'electron-main-local',
              endpoint: '/api/workspace/files/read-text',
              scope: 'workspace-files:read',
              capability: 'files.readText',
              subject: 'workspace-text',
              expiresAt: Date.now() + DECISION_TTL_MS,
              revision: '1',
            })}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(forwardedRequest),
        });
        const body: unknown = await response.json();
        if (response.status === 200 && isWorkspaceTextResponse(body)) {
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
    && isNonEmptyString(value.sessionKey);
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
    && isNonEmptyString(value.sessionKey)
    && isRelativePath(value.relativePath)
    && (value.maxBytes === undefined || isSafeInteger(value.maxBytes));
}

function isRelativePath(value: unknown): value is string {
  return isNonEmptyString(value)
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
    && isNonEmptyString(value.name)
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
