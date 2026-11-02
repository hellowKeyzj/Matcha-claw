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
