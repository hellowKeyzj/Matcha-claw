import type { RuntimeHostDeliveryIssuer } from '../../bootstrap';
import { validateSessionIdentity } from '../../../../desktop-contract/runtime-address';

const DECISION_TTL_MS = 30_000;

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
  status: 200 | 400 | 401 | 404 | 409 | 422 | 503;
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
  | 'externalConnectors.probe'
  | 'externalConnectors.sessionStatus'
  | 'externalConnectors.sessionMcpServerEnabled'
  | 'externalConnectors.get'
  | 'externalConnectors.upsert'
  | 'externalConnectors.remove';

export function createExternalConnectorsTransport(
  issuer: RuntimeHostDeliveryIssuer,
  providerModelsTransportPort: number,
  fetcher: typeof fetch = fetch,
): ExternalConnectorsTransport {
  const url = `http://127.0.0.1:${providerModelsTransportPort}/api/external-connectors`;
  return {
    async execute(request: unknown): Promise<ExternalConnectorsTransportResponse> {
      if (!isRequest(request)) return { status: 400, body: INVALID_REQUEST };
      try {
        const response = await fetcher(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${issuer.signDecision({
              principal: 'electron-main-local',
              endpoint: '/api/external-connectors',
              scope: 'environment:external-connectors',
              capability: request.operationId,
              subject: 'external-connectors',
              expiresAt: Date.now() + DECISION_TTL_MS,
              revision: '1',
            })}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(request),
        });
        const body: unknown = await response.json();
        if (response.status === 200 && isSuccessResponse(request.operationId, body)) {
          return { status: 200, body: projectPublicResponse(request.operationId, body) };
        }
        if (response.status === 400) return { status: 400, body: INVALID_REQUEST };
        if (response.status === 401) return { status: 401, body: { success: false, error: 'External connector authorization failed' } };
        if (response.status === 404) return { status: 404, body: { success: false, error: 'External connector is unknown' } };
        if (response.status === 409) return { status: 409, body: { success: false, error: 'External connector mutation outcome is unknown; reopen before retrying' } };
        if (response.status === 422) return { status: 422, body: REJECTED };
      } catch {
        // Public delivery deliberately redacts loopback and host failures.
      }
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

function isSuccessResponse(operation: ExternalConnectorOperation, value: unknown): boolean {
  if (operation === 'externalConnectors.list') {
    return isRecord(value) && hasExactKeys(value, ['connectors'])
      && Array.isArray(value.connectors) && value.connectors.every(isPublicConnector);
  }
  if (operation === 'externalConnectors.catalog') {
    return isRecord(value) && hasExactKeys(value, ['programs'])
      && Array.isArray(value.programs) && value.programs.every(isProgram);
  }
  if (operation === 'externalConnectors.status') {
    return isRecord(value) && hasExactKeys(value, ['statuses'])
      && Array.isArray(value.statuses) && value.statuses.every(isStatus);
  }
  if (operation === 'externalConnectors.probe') {
    return isRecord(value) && hasExactKeys(value, ['status']) && isStatus(value.status);
  }
  if (operation === 'externalConnectors.sessionStatus') {
    return isRecord(value)
      && hasExactKeys(value, ['statuses'])
      && Array.isArray(value.statuses)
      && value.statuses.every(isSessionStatus);
  }
  if (operation === 'externalConnectors.sessionMcpServerEnabled') {
    return isRecord(value)
      && hasExactKeys(value, ['success', 'effectiveNextRun'])
      && value.success === true
      && value.effectiveNextRun === true;
  }
  if (operation === 'externalConnectors.get') {
    return isRecord(value) && hasExactKeys(value, ['connector']) && isPublicConnector(value.connector);
  }
  if (operation === 'externalConnectors.upsert') {
    return isRecord(value)
      && hasExactKeys(value, ['success', 'connector', 'resultType', 'desired', 'applied', 'observed'])
      && value.success === true
      && isPublicConnector(value.connector)
      && (value.resultType === 'created' || value.resultType === 'updated')
      && isDesired(value.desired, 'stored')
      && isApplied(value.applied)
      && isObserved(value.observed);
  }
  return isRecord(value)
    && hasExactKeys(value, ['success', 'desired', 'applied', 'observed'])
    && value.success === true
    && isDesired(value.desired, 'removed')
    && isApplied(value.applied)
    && isObserved(value.observed);
}

function projectPublicResponse(operation: ExternalConnectorOperation, body: unknown): unknown {
  if (operation === 'externalConnectors.sessionStatus' && isRecord(body)) {
    return {
      statuses: (body.statuses as unknown[]).map(projectSessionStatus),
    };
  }
  return body;
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

function isStatus(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, ['connectorId', 'resultType', 'latencyMs', 'reason', 'safeProbe'])) return false;
  return isConnectorId(value.connectorId)
    && (value.resultType === 'connected' || value.resultType === 'disconnected'
      || value.resultType === 'unsupported' || value.resultType === 'disabled' || value.resultType === 'unknown')
    && (value.latencyMs === undefined || (typeof value.latencyMs === 'number' && value.latencyMs >= 0))
    && optionalText(value.reason)
    && typeof value.safeProbe === 'boolean';
}

function isSessionStatus(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'connectorId', 'displayName', 'adapterId', 'targetKind', 'resultType', 'reason', 'details',
  ])) return false;
  return isConnectorId(value.connectorId)
    && optionalText(value.displayName)
    && isNonemptyText(value.adapterId)
    && value.targetKind === 'session'
    && isSessionResultType(value.resultType)
    && optionalText(value.reason)
    && optionalSessionStatusDetails(value.details);
}

function projectSessionStatus(value: Record<string, unknown>): Record<string, unknown> {
  const details = isRecord(value.details) ? {
    ...(value.details.serverId === undefined ? {} : { serverId: value.details.serverId }),
    ...(value.details.sessionKey === undefined ? {} : { sessionKey: value.details.sessionKey }),
    ...(value.details.toolCount === undefined ? {} : { toolCount: value.details.toolCount }),
    ...(value.details.launchSummary === undefined ? {} : { launchSummary: value.details.launchSummary }),
    ...(value.details.enabledNextRun === undefined ? {} : { enabledNextRun: value.details.enabledNextRun }),
    ...(value.details.enabledConfigurable === undefined ? {} : { enabledConfigurable: value.details.enabledConfigurable }),
  } : undefined;
  return {
    connectorId: value.connectorId,
    ...(value.displayName === undefined ? {} : { displayName: value.displayName }),
    adapterId: value.adapterId,
    targetKind: 'session',
    resultType: value.resultType,
    ...(value.reason === undefined ? {} : { reason: value.reason }),
    ...(details === undefined ? {} : { details }),
  };
}

function optionalSessionStatusDetails(value: unknown): boolean {
  return value === undefined || (isRecord(value)
    && hasOnlyKeys(value, ['serverId', 'sessionKey', 'toolCount', 'launchSummary', 'enabledNextRun', 'enabledConfigurable'])
    && optionalText(value.serverId)
    && optionalText(value.sessionKey)
    && (value.toolCount === undefined || (typeof value.toolCount === 'number' && Number.isSafeInteger(value.toolCount) && value.toolCount >= 0))
    && optionalText(value.launchSummary)
    && optionalBoolean(value.enabledNextRun)
    && optionalBoolean(value.enabledConfigurable));
}

function isSessionResultType(value: unknown): boolean {
  return value === 'connected' || value === 'disconnected' || value === 'pending'
    || value === 'unsupported' || value === 'disabled' || value === 'unknown';
}

function isDesired(value: unknown, status: 'stored' | 'removed'): boolean {
  return isRecord(value)
    && hasOnlyKeys(value, ['status', 'revision'])
    && value.status === status
    && (value.revision === undefined || (typeof value.revision === 'number' && Number.isSafeInteger(value.revision) && value.revision >= 0));
}

function isApplied(value: unknown): boolean {
  return isRecord(value)
    && ((hasExactKeys(value, ['status', 'changed']) && value.status === 'written' && typeof value.changed === 'boolean')
      || (hasExactKeys(value, ['status']) && (value.status === 'unknown' || value.status === 'unavailable')));
}

function isObserved(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['status']) && value.status === 'not-observed';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
