import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { hasExactKeys, isRecord, sendLoopbackJson } from '../client';

const ENDPOINT = '/api/openclaw/mcp-servers';
const UNAVAILABLE = {
  success: false,
  error: 'OpenClaw MCP servers are unavailable',
} as const;
const INVALID_REQUEST = {
  success: false,
  error: 'OpenClaw MCP servers request is invalid',
} as const;

type Operation = 'openClawMcpServers.list';

type Request = Readonly<{
  id: 'openclaw.mcpServers';
  operationId: Operation;
  scope: Readonly<{ kind: 'openclaw-mcp-servers' }>;
  target: Readonly<{ kind: 'openclaw-mcp-servers' }>;
  input: Record<string, unknown>;
}>;

export type OpenClawMcpServersTransportResponse = Readonly<{
  status: 200 | 400 | 503;
  body: unknown;
}>;

export interface OpenClawMcpServersTransport {
  execute(request: unknown): Promise<OpenClawMcpServersTransportResponse>;
}

export function createOpenClawMcpServersTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): OpenClawMcpServersTransport {
  return {
    async execute(request: unknown): Promise<OpenClawMcpServersTransportResponse> {
      if (!isRequest(request)) return { status: 400, body: INVALID_REQUEST };
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        path: ENDPOINT,
        issuer,
        decision: {
          endpoint: ENDPOINT,
          scope: 'openclaw:mcp-servers',
          capability: request.operationId,
          subject: 'openclaw-mcp-servers',
        },
        method: 'POST',
        fetcher,
        body: request,
      });
      if (response?.status === 200 && isSuccessResponse(request.operationId, response.body)) {
        return { status: 200, body: projectPublicResponse(request.operationId, response.body) };
      }
      if (response?.status === 400) return { status: 400, body: INVALID_REQUEST };
      return { status: 503, body: UNAVAILABLE };
    },
  };
}

function isRequest(value: unknown): value is Request {
  if (!isRecord(value)
    || !hasExactKeys(value, ['id', 'operationId', 'scope', 'target', 'input'])
    || value.id !== 'openclaw.mcpServers'
    || !isRecord(value.scope)
    || !hasExactKeys(value.scope, ['kind'])
    || value.scope.kind !== 'openclaw-mcp-servers'
    || !isRecord(value.target)
    || !hasExactKeys(value.target, ['kind'])
    || value.target.kind !== 'openclaw-mcp-servers'
    || !isRecord(value.input)) return false;

  return value.operationId === 'openClawMcpServers.list'
    && hasExactKeys(value.input, ['kind'])
    && value.input.kind === 'list';
}

function isSuccessResponse(_operation: Operation, value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['servers'])
    && Array.isArray(value.servers)
    && value.servers.every(isServerSummary);
}

function projectPublicResponse(_operation: Operation, value: unknown): unknown {
  if (!isRecord(value)) return value;
  return { servers: (value.servers as Record<string, unknown>[]).map(projectServerSummary) };
}

function isServerSummary(value: unknown): boolean {
  if (!isRecord(value)
    || !hasExpectedKeys(
      value,
      ['serverId', 'displayName', 'kind', 'source', 'enabled', 'managed', 'editable', 'removable'],
      ['connectorId', 'description'],
    )) return false;
  return isSafeText(value.serverId, 128)
    && optionalSafeText(value.connectorId, 128)
    && isSafeText(value.displayName)
    && optionalSafeText(value.description)
    && isServerKind(value.kind)
    && isServerSource(value.source)
    && typeof value.enabled === 'boolean'
    && typeof value.managed === 'boolean'
    && typeof value.editable === 'boolean'
    && typeof value.removable === 'boolean';
}

function projectServerSummary(value: Record<string, unknown>): Record<string, unknown> {
  return {
    serverId: value.serverId,
    ...(value.connectorId === undefined ? {} : { connectorId: value.connectorId }),
    displayName: value.displayName,
    ...(value.description === undefined ? {} : { description: value.description }),
    kind: value.kind,
    source: value.source,
    enabled: value.enabled,
    managed: value.managed,
    editable: value.editable,
    removable: value.removable,
  };
}


function isServerKind(value: unknown): boolean {
  return value === 'mcp-stdio' || value === 'mcp-http' || value === 'unknown';
}

function isServerSource(value: unknown): boolean {
  return value === 'preset' || value === 'external' || value === 'openclaw';
}

function optionalSafeText(value: unknown, maxBytes = 16 * 1024): boolean {
  return value === undefined || isSafeText(value, maxBytes);
}

function isSafeText(value: unknown, maxBytes = 16 * 1024): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && Buffer.byteLength(value, 'utf8') <= maxBytes
    && !/\p{Cc}/u.test(value);
}

function hasExpectedKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}
