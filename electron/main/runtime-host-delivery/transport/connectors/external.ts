import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { sessionIdentitiesEqual, validateSessionIdentity, type SessionIdentity } from '../../../../../src/types/desktop/runtime-address';
import { hasExactKeys, isRecord, sendLoopbackJson } from '../client';
import { isConnectorObservationResult } from '../../../../../src/types/connectors-observation';

const UNAVAILABLE = {
  success: false,
  error: 'External connectors are unavailable',
} as const;

const INVALID_REQUEST = {
  success: false,
  error: 'External connector request is invalid',
} as const;

const REJECTED = {
  success: false,
  error: 'External connector request was rejected',
} as const;

export type ExternalConnectorsTransportResponse = Readonly<{
  status: 200 | 202 | 400 | 401 | 404 | 409 | 422 | 503;
  body: unknown;
}>;

export interface ExternalConnectorsTransport {
  execute(request: unknown): Promise<ExternalConnectorsTransportResponse>;
}

type Request = Readonly<{
  id: 'external.connectors';
  operationId: ExternalConnectorOperation;
  scope: Readonly<{ kind: 'external-connector-catalog' }>;
  target: Readonly<{ kind: 'external-connectors' }>;
  input: Record<string, unknown>;
}>;

type ExternalConnectorOperation =
  | 'externalConnectors.list'
  | 'externalConnectors.catalog'
  | 'externalConnectors.status'
  | 'externalConnectors.observationResult'
  | 'externalConnectors.probe'
  | 'externalConnectors.sessionStatus'
  | 'externalConnectors.sessionMcpServerEnabled'
  | 'externalConnectors.get'
  | 'externalConnectors.upsert'
  | 'externalConnectors.remove';

export function createExternalConnectorsTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): ExternalConnectorsTransport {
  return {
    async execute(request: unknown): Promise<ExternalConnectorsTransportResponse> {
      if (!isRequest(request)) return { status: 400, body: INVALID_REQUEST };
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        path: '/api/external-connectors',
        issuer,
        decision: {
          endpoint: '/api/external-connectors',
          scope: 'environment:external-connectors',
          capability: request.operationId,
          subject: 'external-connectors',
        },
        method: 'POST',
        fetcher,
        body: request,
      });
      if (response?.status === 202
        && (request.operationId === 'externalConnectors.upsert' || request.operationId === 'externalConnectors.remove' || request.operationId === 'externalConnectors.sessionMcpServerEnabled'
          || request.operationId === 'externalConnectors.status' || request.operationId === 'externalConnectors.probe' || request.operationId === 'externalConnectors.sessionStatus')
        && isRecord(response.body) && hasExactKeys(response.body, ['callId', 'accepted'])
        && typeof response.body.callId === 'string' && /^[a-f0-9]{32}$/.test(response.body.callId)
        && response.body.accepted === true) {
        return { status: 202, body: { callId: response.body.callId, accepted: true } };
      }
      if (response?.status === 200 && isSuccessResponse(request, response.body)) {
        return { status: 200, body: response.body };
      }
      if (response?.status === 400) return { status: 400, body: INVALID_REQUEST };
      if (response?.status === 401) return { status: 401, body: { success: false, error: 'External connector authorization failed' } };
      if (request.operationId === 'externalConnectors.observationResult' && response?.status === 404) {
        return { status: 404, body: { success: false, error: 'Connector observation result is unavailable or expired' } };
      }
      if (request.operationId === 'externalConnectors.observationResult' && response?.status === 409) {
        return { status: 409, body: { success: false, error: 'Connector observation is pending' } };
      }
      if (response?.status === 404) return { status: 404, body: { success: false, error: 'External connector is unknown' } };
      if (response?.status === 409) return { status: 409, body: { success: false, error: 'External connector mutation outcome is unknown; reopen before retrying' } };
      if (response?.status === 422) return { status: 422, body: REJECTED };
      return { status: 503, body: UNAVAILABLE };
    },
  };
}

function isRequest(value: unknown): value is Request {
  if (!isRecord(value)
    || !hasExactKeys(value, ['id', 'operationId', 'scope', 'target', 'input'])
    || value.id !== 'external.connectors'
    || !isRecord(value.scope)
    || !hasExactKeys(value.scope, ['kind'])
    || value.scope.kind !== 'external-connector-catalog'
    || !isRecord(value.target)
    || !hasExactKeys(value.target, ['kind'])
    || value.target.kind !== 'external-connectors'
    || !isRecord(value.input)) return false;

  switch (value.operationId) {
    case 'externalConnectors.list':
    case 'externalConnectors.catalog':
    case 'externalConnectors.status':
      return hasExactKeys(value.input, ['kind'])
        && typeof value.input.kind === 'string'
        && value.input.kind === operationKind(value.operationId);
    case 'externalConnectors.observationResult':
      return (hasExactKeys(value.input, ['kind', 'callId'])
        || (hasExactKeys(value.input, ['kind', 'callId', 'sessionIdentity']) && !validateSessionIdentity(value.input.sessionIdentity)))
        && value.input.kind === 'observationResult'
        && typeof value.input.callId === 'string' && /^[a-f0-9]{32}$/.test(value.input.callId);
    case 'externalConnectors.sessionStatus':
      return hasExactKeys(value.input, ['kind', 'sessionIdentity'])
        && value.input.kind === 'sessionStatus'
        && !validateSessionIdentity(value.input.sessionIdentity);
    case 'externalConnectors.sessionMcpServerEnabled':
      return hasExactKeys(value.input, ['kind', 'sessionIdentity', 'serverId', 'enabled'])
        && value.input.kind === 'sessionMcpServerEnabled'
        && !validateSessionIdentity(value.input.sessionIdentity)
        && isConnectorId(value.input.serverId)
        && typeof value.input.enabled === 'boolean';
    case 'externalConnectors.probe':
    case 'externalConnectors.get':
    case 'externalConnectors.remove':
      return hasExactKeys(value.input, ['kind', 'connectorId'])
        && typeof value.input.kind === 'string'
        && value.input.kind === operationKind(value.operationId)
        && isConnectorId(value.input.connectorId);
    case 'externalConnectors.upsert':
      return hasExactKeys(value.input, ['kind', 'connector'])
        && value.input.kind === 'upsert'
        && isConnectorDraft(value.input.connector);
    default:
      return false;
  }
}

function operationKind(operation: ExternalConnectorOperation): string {
  return operation.slice('externalConnectors.'.length);
}

function isSuccessResponse(request: Request, value: unknown): boolean {
  const operation = request.operationId;
  if (operation === 'externalConnectors.list') {
    return isRecord(value) && hasExactKeys(value, ['connectors'])
      && Array.isArray(value.connectors) && value.connectors.every(isPublicConnector);
  }
  if (operation === 'externalConnectors.catalog') {
    return isRecord(value) && hasExactKeys(value, ['programs'])
      && Array.isArray(value.programs) && value.programs.every(isProgram);
  }
  if (operation === 'externalConnectors.observationResult') {
    return isConnectorObservationResult(value) && value.callId === request.input.callId
      && (value.kind === 'sessionStatus'
        ? request.input.sessionIdentity !== undefined && sessionIdentitiesEqual(value.sessionIdentity, request.input.sessionIdentity as SessionIdentity)
        : request.input.sessionIdentity === undefined);
  }
  if (operation === 'externalConnectors.get') {
    return isRecord(value) && hasExactKeys(value, ['connector']) && isPublicConnector(value.connector);
  }
  return false;
}

function isConnectorDraft(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'id', 'kind', 'displayName', 'description', 'enabled', 'workspaceId', 'sourceId',
    'mcpServerProgram', 'tags', 'command', 'args', 'cwd', 'env', 'url', 'transport',
    'headers', 'connectionTimeoutMs', 'baseUrl', 'provider', 'packageName', 'config',
    'secretEnv', 'secretHeaders', 'secretConfigRefs',
  ]) || !isConnectorId(value.id) || !isConnectorKind(value.kind)) return false;
  return optionalText(value.displayName)
    && optionalText(value.description)
    && optionalBoolean(value.enabled)
    && optionalText(value.workspaceId)
    && optionalText(value.sourceId)
    && optionalMcpProgram(value.mcpServerProgram)
    && optionalStringArray(value.tags)
    && optionalSecretReferences(value, value.kind)
    && optionalText(value.command)
    && optionalStringArray(value.args)
    && optionalText(value.cwd)
    && optionalStringMap(value.env)
    && optionalText(value.url)
    && (value.transport === undefined || value.transport === 'streamable-http' || value.transport === 'sse')
    && optionalStringMap(value.headers)
    && optionalPositive(value.connectionTimeoutMs)
    && optionalText(value.baseUrl)
    && optionalText(value.provider)
    && optionalText(value.packageName)
    && optionalRecord(value.config);
}

function isPublicConnector(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'id', 'kind', 'displayName', 'description', 'enabled', 'workspaceId', 'sourceId',
    'mcpServerProgram', 'tags', 'command', 'args', 'cwd', 'env', 'url', 'transport',
    'headers', 'connectionTimeoutMs', 'baseUrl', 'provider', 'packageName', 'config',
    'secretEnv', 'secretHeaders', 'secretConfigRefs',
  ]) || !isConnectorId(value.id) || !isConnectorKind(value.kind)) return false;
  return optionalText(value.displayName)
    && optionalText(value.description)
    && optionalBoolean(value.enabled)
    && optionalText(value.workspaceId)
    && optionalText(value.sourceId)
    && optionalMcpProgram(value.mcpServerProgram)
    && optionalStringArray(value.tags)
    && optionalSecretReferences(value, value.kind)
    && optionalText(value.command)
    && optionalStringArray(value.args)
    && optionalText(value.cwd)
    && optionalStringMap(value.env)
    && optionalText(value.url)
    && (value.transport === undefined || value.transport === 'streamable-http' || value.transport === 'sse')
    && optionalStringMap(value.headers)
    && optionalPositive(value.connectionTimeoutMs)
    && optionalText(value.baseUrl)
    && optionalText(value.provider)
    && optionalText(value.packageName)
    && optionalRecord(value.config);
}

function isProgram(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'id', 'source', 'displayName', 'connectorKinds', 'transport', 'command', 'args', 'url',
    'rootPath', 'envKeys', 'headerKeys',
  ])) return false;
  return isNonemptyText(value.id)
    && isProgramSource(value.source)
    && isNonemptyText(value.displayName)
    && Array.isArray(value.connectorKinds)
    && value.connectorKinds.length > 0
    && value.connectorKinds.every((kind) => kind === 'mcp-stdio' || kind === 'mcp-http')
    && (value.transport === undefined || value.transport === 'streamable-http' || value.transport === 'sse')
    && optionalText(value.command)
    && optionalStringArray(value.args)
    && optionalText(value.url)
    && optionalText(value.rootPath)
    && optionalStringArray(value.envKeys)
    && optionalStringArray(value.headerKeys);
}

function optionalSecretReferences(value: Record<string, unknown>, kind: unknown): boolean {
  const validFields = kind === 'mcp-stdio' || kind === 'cli'
    ? value.secretHeaders === undefined && value.secretConfigRefs === undefined
    : kind === 'mcp-http' || kind === 'http'
      ? value.secretEnv === undefined && value.secretConfigRefs === undefined
      : kind === 'sdk'
        ? value.secretEnv === undefined && value.secretHeaders === undefined
        : false;
  return validFields
    && optionalSecretReferenceMap(value.secretEnv, true)
    && optionalSecretReferenceMap(value.secretHeaders, false)
    && optionalSecretReferenceMap(value.secretConfigRefs, false);
}

function optionalSecretReferenceMap(value: unknown, processEnvironment: boolean): boolean {
  return value === undefined || (isRecord(value) && Object.entries(value).every(([key, reference]) => {
    const validKey = processEnvironment ? validEnvironmentKey(key) : validReferenceKey(key);
    return validKey && isSecretReference(reference);
  }));
}

function isSecretReference(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'ref'])
    && value.kind === 'secret-ref'
    && typeof value.ref === 'string'
    && value.ref.length <= 512
    && value.ref.trim().length > 0
    && !/\p{Cc}/u.test(value.ref)
    && value.ref.split(':').every(Boolean);
}

function validEnvironmentKey(value: string): boolean {
  return value.length > 0 && value.length <= 128
    && [...value].every((character, index) => /[A-Z0-9]/.test(character) || (character === '_' && index > 0));
}

function validReferenceKey(value: string): boolean {
  const allowed = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-/';
  return value.length > 0 && value.length <= 128 && [...value].every((character) => allowed.includes(character));
}

function optionalMcpProgram(value: unknown): boolean {
  return value === undefined || (isRecord(value)
    && hasOnlyKeys(value, ['source', 'programId'])
    && isProgramSource(value.source)
    && optionalText(value.programId));
}

function isProgramSource(value: unknown): boolean {
  return value === 'system-runtime' || value === 'external-command' || value === 'external-url'
    || value === 'bundled-plugin' || value === 'bundled-mcp-app' || value === 'managed-local';
}

function isConnectorKind(value: unknown): boolean {
  return value === 'mcp-stdio' || value === 'mcp-http' || value === 'cli' || value === 'sdk' || value === 'http';
}

function isConnectorId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128;
}

function optionalText(value: unknown): boolean {
  return value === undefined || isNonemptyText(value);
}

function isNonemptyText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function optionalPositive(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value > 0);
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

function optionalStringArray(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every(isNonemptyText));
}

function optionalStringMap(value: unknown): boolean {
  return value === undefined || (isRecord(value) && Object.entries(value).every(([key, item]) => isNonemptyText(key) && typeof item === 'string'));
}

function optionalRecord(value: unknown): boolean {
  return value === undefined || isRecord(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
