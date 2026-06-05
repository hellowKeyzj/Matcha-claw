export type RuntimeAddress = NativeRuntimeAddress | ConnectorRuntimeAddress;

export interface NativeRuntimeAddress {
  kind: 'native-runtime';
  capabilityId: string;
  runtimeAdapterId: string;
  runtimeInstanceId: string;
  agentId: string;
  modelProviderId?: string;
  sessionKey?: string;
}

export interface ConnectorRuntimeAddress {
  kind: 'protocol-connector';
  capabilityId: string;
  protocolId: string;
  connectorId: string;
  endpointId: string;
  agentId: string;
  modelProviderId?: string;
  sessionKey?: string;
}

export type RuntimeAddressKind = RuntimeAddress['kind'];

export interface RuntimeAddressKeyParts {
  capabilityId: string;
  ownerId: string;
  targetId: string;
  agentId: string;
}

export function isNativeRuntimeAddress(input: RuntimeAddress): input is NativeRuntimeAddress {
  return input.kind === 'native-runtime';
}

export function isConnectorRuntimeAddress(input: RuntimeAddress): input is ConnectorRuntimeAddress {
  return input.kind === 'protocol-connector';
}

export function assertRuntimeAddress(input: unknown): asserts input is RuntimeAddress {
  const error = validateRuntimeAddress(input);
  if (error) {
    throw new Error(error);
  }
}

export function validateRuntimeAddress(input: unknown): string | null {
  if (!isRecord(input)) {
    return 'RuntimeAddress must be an object';
  }

  if (input.kind === 'native-runtime') {
    return validateRequiredStrings(input, [
      'capabilityId',
      'runtimeAdapterId',
      'runtimeInstanceId',
      'agentId',
    ]) ?? validateForbiddenKeys(input, [
      'protocolId',
      'connectorId',
      'endpointId',
    ]);
  }

  if (input.kind === 'protocol-connector') {
    return validateRequiredStrings(input, [
      'capabilityId',
      'protocolId',
      'connectorId',
      'endpointId',
      'agentId',
    ]) ?? validateForbiddenKeys(input, [
      'runtimeAdapterId',
      'runtimeInstanceId',
    ]);
  }

  return 'RuntimeAddress kind must be native-runtime or protocol-connector';
}

function optionalModelProviderKey(address: RuntimeAddress): string {
  return address.modelProviderId ? `model-provider:${address.modelProviderId}` : 'model-provider:';
}

export function buildRuntimeAddressKey(address: RuntimeAddress): string {
  assertRuntimeAddress(address);
  if (isNativeRuntimeAddress(address)) {
    return [
      address.capabilityId,
      'native-runtime',
      address.runtimeAdapterId,
      address.runtimeInstanceId,
      address.agentId,
      optionalModelProviderKey(address),
    ].join(':');
  }

  return [
    address.capabilityId,
    'protocol-connector',
    address.protocolId,
    address.connectorId,
    address.endpointId,
    address.agentId,
    optionalModelProviderKey(address),
  ].join(':');
}

export function getRuntimeAddressKeyParts(address: RuntimeAddress): RuntimeAddressKeyParts {
  assertRuntimeAddress(address);
  if (isNativeRuntimeAddress(address)) {
    return {
      capabilityId: address.capabilityId,
      ownerId: address.runtimeAdapterId,
      targetId: address.runtimeInstanceId,
      agentId: address.agentId,
    };
  }

  return {
    capabilityId: address.capabilityId,
    ownerId: `${address.protocolId}/${address.connectorId}`,
    targetId: address.endpointId,
    agentId: address.agentId,
  };
}

function validateRequiredStrings(input: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = input[key];
    if (typeof value !== 'string' || !value.trim()) {
      return `RuntimeAddress ${key} is required`;
    }
  }
  return null;
}

function validateForbiddenKeys(input: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    if (input[key] !== undefined) {
      return `RuntimeAddress ${key} is not allowed for ${input.kind}`;
    }
  }
  return null;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
