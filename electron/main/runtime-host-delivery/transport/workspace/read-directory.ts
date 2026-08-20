import type { RuntimeHostDeliveryIssuer } from '../../bootstrap';

const DECISION_TTL_MS = 30_000;
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
  port: number,
  fetcher: typeof fetch = fetch,
): WorkspaceDirectoryTransport {
  const url = `http://127.0.0.1:${port}/api/workspace/files/list-dir`;
  return {
    async list(request: unknown): Promise<WorkspaceDirectoryTransportResponse> {
      if (!isWorkspaceDirectoryRequest(request)) {
        return { status: 503, body: UNAVAILABLE };
      }
      try {
        const response = await fetcher(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${issuer.signDecision({
              principal: 'electron-main-local',
              endpoint: '/api/workspace/files/list-dir',
              scope: 'workspace-files:list',
              capability: 'files.listDir',
              subject: 'workspace-directory',
              expiresAt: Date.now() + DECISION_TTL_MS,
              revision: '1',
            })}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(request),
        });
        const body: unknown = await response.json();
        if (response.status === 200 && isWorkspaceDirectoryResponse(body)) {
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
    && isNonEmptyString(value.sessionKey);
}

function isTarget(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['kind']) && value.kind === 'workspace-file';
}

function isInput(value: unknown): value is WorkspaceDirectoryRequest['input'] {
  return isRecord(value)
    && hasExactKeys(value, ['endpoint', 'sessionKey', 'relativePath', 'includeHidden'])
    && isEndpoint(value.endpoint)
    && isNonEmptyString(value.sessionKey)
    && isDirectoryRelativePath(value.relativePath)
    && typeof value.includeHidden === 'boolean';
}

function isDirectoryRelativePath(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 4096
    && !value.includes('\0')
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
    && isNonEmptyString(value.relativePath)
    && isNonEmptyString(value.display)
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0');
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
