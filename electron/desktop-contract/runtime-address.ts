export interface NativeRuntimeEndpointRef {
  readonly kind: 'native-runtime';
  readonly runtimeAdapterId: string;
  readonly runtimeInstanceId: string;
}

export interface ConnectorRuntimeEndpointRef {
  readonly kind: 'protocol-connector';
  readonly protocolId: string;
  readonly connectorId: string;
  readonly endpointId: string;
}

export type RuntimeEndpointRef = NativeRuntimeEndpointRef | ConnectorRuntimeEndpointRef;

export interface SessionIdentity {
  readonly endpoint: RuntimeEndpointRef;
  readonly agentId: string;
  readonly sessionKey: string;
}

export type RuntimeScope = AppScope | RuntimeInstanceScope | AgentScope | SessionScope | WorkspaceMediaSessionScope | WorkspaceScope | TeamRunScope | ProviderRoutingScope;
export type RuntimeScopeKind = RuntimeScope['kind'];

export interface AppScope {
  readonly kind: 'app';
}

export interface RuntimeInstanceScope {
  readonly kind: 'runtime-instance';
  readonly endpoint: RuntimeEndpointRef;
}

export interface AgentScope {
  readonly kind: 'agent';
  readonly endpoint: RuntimeEndpointRef;
  readonly agentId: string;
}

export interface SessionScope {
  readonly kind: 'session';
  readonly identity: SessionIdentity;
}

export interface WorkspaceMediaSessionScope {
  readonly kind: 'session';
  readonly endpoint: RuntimeEndpointRef;
  readonly sessionKey: string;
}

export interface WorkspaceScope {
  readonly kind: 'workspace';
  readonly endpoint: RuntimeEndpointRef;
  readonly workspaceId?: string;
  readonly sourceId?: string;
}

export interface TeamRunScope {
  readonly kind: 'team-run';
  readonly endpoint: RuntimeEndpointRef;
  readonly runId: string;
  readonly teamId?: string;
}

export interface ProviderRoutingScope {
  readonly kind: 'provider-routing';
}

export function nativeRuntimeEndpoint(input: Omit<NativeRuntimeEndpointRef, 'kind'>): NativeRuntimeEndpointRef {
  const endpoint = { kind: 'native-runtime' as const, ...input };
  assertRuntimeEndpointRef(endpoint);
  return endpoint;
}

export function connectorRuntimeEndpoint(input: Omit<ConnectorRuntimeEndpointRef, 'kind'>): ConnectorRuntimeEndpointRef {
  const endpoint = { kind: 'protocol-connector' as const, ...input };
  assertRuntimeEndpointRef(endpoint);
  return endpoint;
}

export function appScope(): AppScope {
  return { kind: 'app' };
}

export function runtimeInstanceScope(endpoint: RuntimeEndpointRef): RuntimeInstanceScope {
  assertRuntimeEndpointRef(endpoint);
  return { kind: 'runtime-instance', endpoint };
}

export function agentScope(endpoint: RuntimeEndpointRef, agentId: string): AgentScope {
  assertRuntimeEndpointRef(endpoint);
  assertIdentity(agentId);
  return { kind: 'agent', endpoint, agentId };
}

export function sessionScope(identity: SessionIdentity): SessionScope {
  assertSessionIdentity(identity);
  return { kind: 'session', identity };
}

export function workspaceScope(endpoint: RuntimeEndpointRef, workspaceId?: string, sourceId?: string): WorkspaceScope {
  assertRuntimeEndpointRef(endpoint);
  if (workspaceId !== undefined) assertIdentity(workspaceId);
  if (sourceId !== undefined) assertIdentity(sourceId);
  return {
    kind: 'workspace',
    endpoint,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(sourceId === undefined ? {} : { sourceId }),
  };
}

export function teamRunScope(endpoint: RuntimeEndpointRef, runId: string, teamId?: string): TeamRunScope {
  assertRuntimeEndpointRef(endpoint);
  assertIdentity(runId);
  if (teamId !== undefined) assertIdentity(teamId);
  return { kind: 'team-run', endpoint, runId, ...(teamId === undefined ? {} : { teamId }) };
}

export function buildRuntimeEndpointKey(endpoint: RuntimeEndpointRef): string {
  assertRuntimeEndpointRef(endpoint);
  if (endpoint.kind === 'protocol-connector') {
    return JSON.stringify({
      type: 'runtime-endpoint',
      kind: endpoint.kind,
      protocolId: endpoint.protocolId,
      connectorId: endpoint.connectorId,
      endpointId: endpoint.endpointId,
    });
  }
  return JSON.stringify({
    type: 'runtime-endpoint',
    kind: endpoint.kind,
    runtimeAdapterId: endpoint.runtimeAdapterId,
    runtimeInstanceId: endpoint.runtimeInstanceId,
  });
}

export function buildSessionIdentityKey(identity: SessionIdentity): string {
  assertSessionIdentity(identity);
  return JSON.stringify({
    type: 'session-identity',
    endpoint: JSON.parse(buildRuntimeEndpointKey(identity.endpoint)),
    agentId: identity.agentId,
    sessionKey: identity.sessionKey,
  });
}

export function buildCapabilityScopeKey(scope: RuntimeScope): string {
  assertRuntimeScope(scope);
  switch (scope.kind) {
    case 'app':
      return JSON.stringify({ type: 'runtime-scope', kind: 'app' });
    case 'runtime-instance':
      return JSON.stringify({ type: 'runtime-scope', kind: 'runtime-instance', endpoint: JSON.parse(buildRuntimeEndpointKey(scope.endpoint)) });
    case 'agent':
      return JSON.stringify({ type: 'runtime-scope', kind: 'agent', endpoint: JSON.parse(buildRuntimeEndpointKey(scope.endpoint)), agentId: scope.agentId });
    case 'session':
      if ('identity' in scope) {
        return JSON.stringify({ type: 'runtime-scope', kind: 'session', identity: JSON.parse(buildSessionIdentityKey(scope.identity)) });
      }
      return JSON.stringify({
        type: 'runtime-scope',
        kind: 'session',
        endpoint: JSON.parse(buildRuntimeEndpointKey(scope.endpoint)),
        sessionKey: scope.sessionKey,
      });
    case 'workspace':
      return JSON.stringify({
        type: 'runtime-scope',
        kind: 'workspace',
        endpoint: JSON.parse(buildRuntimeEndpointKey(scope.endpoint)),
        ...(scope.workspaceId === undefined ? {} : { workspaceId: scope.workspaceId }),
        ...(scope.sourceId === undefined ? {} : { sourceId: scope.sourceId }),
      });
    case 'team-run':
      return JSON.stringify({
        type: 'runtime-scope',
        kind: 'team-run',
        endpoint: JSON.parse(buildRuntimeEndpointKey(scope.endpoint)),
        runId: scope.runId,
        ...(scope.teamId === undefined ? {} : { teamId: scope.teamId }),
      });
    case 'provider-routing':
      return JSON.stringify({ type: 'runtime-scope', kind: 'provider-routing' });
  }
}

export function runtimeEndpointsEqual(left: RuntimeEndpointRef, right: RuntimeEndpointRef): boolean {
  return buildRuntimeEndpointKey(left) === buildRuntimeEndpointKey(right);
}

export function sessionIdentitiesEqual(left: SessionIdentity, right: SessionIdentity): boolean {
  return buildSessionIdentityKey(left) === buildSessionIdentityKey(right);
}

export function assertRuntimeEndpointRef(input: unknown): asserts input is RuntimeEndpointRef {
  const error = validateRuntimeEndpointRef(input);
  if (error) throw new Error(error);
}

export function assertRuntimeScope(input: unknown): asserts input is RuntimeScope {
  const error = validateRuntimeScope(input);
  if (error) throw new Error(error);
}

export function assertSessionIdentity(input: unknown): asserts input is SessionIdentity {
  const error = validateSessionIdentity(input);
  if (error) throw new Error(error);
}

export function validateRuntimeEndpointRef(input: unknown): string | null {
  if (!isRecord(input) || typeof input.kind !== 'string') {
    return 'RuntimeEndpointRef is invalid';
  }
  if (input.kind === 'native-runtime') {
    return hasExactKeys(input, ['kind', 'runtimeAdapterId', 'runtimeInstanceId'])
      && isIdentity(input.runtimeAdapterId)
      && isIdentity(input.runtimeInstanceId)
      ? null
      : 'RuntimeEndpointRef is invalid';
  }
  if (input.kind === 'protocol-connector') {
    return hasExactKeys(input, ['kind', 'protocolId', 'connectorId', 'endpointId'])
      && isIdentity(input.protocolId)
      && isIdentity(input.connectorId)
      && isIdentity(input.endpointId)
      ? null
      : 'RuntimeEndpointRef is invalid';
  }
  return 'RuntimeEndpointRef is invalid';
}

export function validateSessionIdentity(input: unknown): string | null {
  if (!isRecord(input) || !hasExactKeys(input, ['endpoint', 'agentId', 'sessionKey'])) {
    return 'SessionIdentity is invalid';
  }
  if (validateRuntimeEndpointRef(input.endpoint) || !isIdentity(input.agentId) || !isIdentity(input.sessionKey)) {
    return 'SessionIdentity is invalid';
  }
  return null;
}

export function validateRuntimeScope(input: unknown): string | null {
  if (!isRecord(input) || typeof input.kind !== 'string') return 'RuntimeScope is invalid';
  switch (input.kind) {
    case 'app':
      return hasExactKeys(input, ['kind']) ? null : 'RuntimeScope is invalid';
    case 'runtime-instance':
      return hasExactKeys(input, ['kind', 'endpoint']) && !validateRuntimeEndpointRef(input.endpoint) ? null : 'RuntimeScope is invalid';
    case 'agent':
      return hasExactKeys(input, ['kind', 'endpoint', 'agentId']) && !validateRuntimeEndpointRef(input.endpoint) && isIdentity(input.agentId) ? null : 'RuntimeScope is invalid';
    case 'session':
      if (hasExactKeys(input, ['kind', 'identity'])) {
        return !validateSessionIdentity(input.identity) ? null : 'RuntimeScope is invalid';
      }
      return hasExactKeys(input, ['kind', 'endpoint', 'sessionKey'])
        && !validateRuntimeEndpointRef(input.endpoint)
        && isIdentity(input.sessionKey)
        ? null
        : 'RuntimeScope is invalid';
    case 'workspace':
      return hasOnlyKeys(input, ['kind', 'endpoint', 'workspaceId', 'sourceId'])
        && !validateRuntimeEndpointRef(input.endpoint)
        && (input.workspaceId === undefined || isIdentity(input.workspaceId))
        && (input.sourceId === undefined || isIdentity(input.sourceId))
        ? null
        : 'RuntimeScope is invalid';
    case 'team-run':
      return hasOnlyKeys(input, ['kind', 'endpoint', 'runId', 'teamId'])
        && !validateRuntimeEndpointRef(input.endpoint)
        && isIdentity(input.runId)
        && (input.teamId === undefined || isIdentity(input.teamId))
        ? null
        : 'RuntimeScope is invalid';
    case 'provider-routing':
      return hasExactKeys(input, ['kind']) ? null : 'RuntimeScope is invalid';
    default:
      return 'RuntimeScope is invalid';
  }
}

export function scopeContainsSessionIdentity(scope: RuntimeScope, identity: SessionIdentity): boolean {
  assertRuntimeScope(scope);
  assertSessionIdentity(identity);
  switch (scope.kind) {
    case 'session': return 'identity' in scope
      ? sessionIdentitiesEqual(scope.identity, identity)
      : scope.sessionKey === identity.sessionKey && runtimeEndpointsEqual(scope.endpoint, identity.endpoint);
    case 'agent': return scope.agentId === identity.agentId && runtimeEndpointsEqual(scope.endpoint, identity.endpoint);
    case 'runtime-instance':
    case 'workspace':
    case 'team-run': return runtimeEndpointsEqual(scope.endpoint, identity.endpoint);
    case 'app': return false;
  }
}

export function workspaceScopeContains(
  scope: RuntimeScope,
  endpoint: RuntimeEndpointRef,
  workspaceId: string,
  sourceId: string,
  identity: SessionIdentity,
): boolean {
  return scope.kind === 'workspace'
    && scopeContainsSessionIdentity(scope, identity)
    && runtimeEndpointsEqual(scope.endpoint, endpoint)
    && scope.workspaceId === workspaceId
    && scope.sourceId === sourceId;
}

function assertIdentity(value: string): void {
  if (!isIdentity(value)) throw new Error('Runtime address identity is invalid');
}

function isIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('\0');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
