import type { CapabilityDescriptor } from '../../../../src/types/desktop/capability-descriptor';
import {
  buildCapabilityScopeKey,
  validateRuntimeScope,
  type RuntimeScope,
} from '../../../../src/types/desktop/runtime-address';
import type { RuntimeHostDeliveryIssuer } from '../issuer';
import { hasExactKeys, isRecord, sendLoopbackJson } from './client';

const CAPABILITY_DIRECTORY_UNAVAILABLE = {
  success: false,
  error: 'Capability directory is unavailable',
} as const;
const CAPABILITY_NOT_AVAILABLE = {
  success: false,
  error: 'Capability is not available',
} as const;
const CAPABILITIES_LIST_PATH = '/api/capabilities/list';
const CAPABILITIES_DESCRIBE_PATH = '/api/capabilities/describe';

export type CapabilityDirectory = Readonly<{
  capabilities: CapabilityDescriptor[];
}>;

export type CapabilityDirectoryListResponse = Readonly<{
  status: 200 | 503;
  body: CapabilityDirectory | typeof CAPABILITY_DIRECTORY_UNAVAILABLE;
}>;

export type CapabilityDirectoryDescribeResponse = Readonly<{
  status: 200 | 404 | 503;
  body: Readonly<{ capability: CapabilityDescriptor }>
    | typeof CAPABILITY_NOT_AVAILABLE
    | typeof CAPABILITY_DIRECTORY_UNAVAILABLE;
}>;

export interface CapabilityDirectoryTransport {
  list(): Promise<CapabilityDirectoryListResponse>;
  describe(input: { id: string; scope: RuntimeScope }): Promise<CapabilityDirectoryDescribeResponse>;
}

export function createCapabilityDirectoryTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): CapabilityDirectoryTransport {
  return {
    async list(): Promise<CapabilityDirectoryListResponse> {
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        path: CAPABILITIES_LIST_PATH,
        issuer,
        decision: listDecision(),
        method: 'GET',
        fetcher,
        emptyContentLength: true,
      });
      if (response?.status === 200 && isCapabilityDirectory(response.body)) {
        return { status: 200, body: response.body };
      }
      return { status: 503, body: CAPABILITY_DIRECTORY_UNAVAILABLE };
    },

    async describe(input): Promise<CapabilityDirectoryDescribeResponse> {
      if (!isDescribeInput(input)) {
        return { status: 404, body: CAPABILITY_NOT_AVAILABLE };
      }
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        path: CAPABILITIES_DESCRIBE_PATH,
        issuer,
        decision: describeDecision(),
        method: 'POST',
        fetcher,
        body: input,
      });
      if (response?.status === 200 && isCapabilityDescribeResponse(response.body, input)) {
        return { status: 200, body: response.body };
      }
      if (response?.status === 404 && isPublicFailure(response.body)) {
        return { status: 404, body: CAPABILITY_NOT_AVAILABLE };
      }
      return { status: 503, body: CAPABILITY_DIRECTORY_UNAVAILABLE };
    },
  };
}

function listDecision() {
  return {
    endpoint: CAPABILITIES_LIST_PATH,
    scope: 'capability-directory:read',
    capability: 'capability.directory.list',
    subject: 'capability-directory',
  } as const;
}

function describeDecision() {
  return {
    endpoint: CAPABILITIES_DESCRIBE_PATH,
    scope: 'capability-directory:read',
    capability: 'capability.directory.describe',
    subject: 'capability-directory',
  } as const;
}

function isDescribeInput(value: unknown): value is { id: string; scope: RuntimeScope } {
  return isRecord(value)
    && hasExactKeys(value, ['id', 'scope'])
    && isCapabilityText(value.id)
    && validateRuntimeScope(value.scope) === null;
}

function isCapabilityDirectory(value: unknown): value is CapabilityDirectory {
  if (!isRecord(value)
    || !hasExactKeys(value, ['capabilities'])
    || !Array.isArray(value.capabilities)) {
    return false;
  }
  const ids = new Set<string>();
  for (const descriptor of value.capabilities) {
    if (!isCapabilityDescriptor(descriptor) || ids.has(descriptor.id)) return false;
    ids.add(descriptor.id);
  }
  return true;
}

function isCapabilityDescribeResponse(
  value: unknown,
  request: { id: string; scope: RuntimeScope },
): value is Readonly<{ capability: CapabilityDescriptor }> {
  return isRecord(value)
    && hasExactKeys(value, ['capability'])
    && isCapabilityDescriptor(value.capability)
    && value.capability.id === request.id
    && sameRuntimeScope(value.capability.scope, request.scope);
}

function isCapabilityDescriptor(value: unknown): value is CapabilityDescriptor {
  const allowed = [
    'id',
    'kind',
    'scopeKind',
    'scope',
    'targetKinds',
    'runtimeAdapterId',
    'runtimeInstanceId',
    'protocolId',
    'connectorId',
    'endpointId',
    'targetAgentIds',
    'supportLevel',
    'availability',
    'operations',
    'policyScope',
    'ownerModuleId',
    'routeOwnerId',
  ] as const;
  const required = [
    'id',
    'kind',
    'scopeKind',
    'scope',
    'targetKinds',
    'supportLevel',
    'availability',
    'operations',
    'policyScope',
    'ownerModuleId',
    'routeOwnerId',
  ] as const;
  return isRecord(value)
    && isRecord(value.scope)
    && hasOnlyKeys(value, allowed)
    && required.every((key) => Object.hasOwn(value, key))
    && isCapabilityText(value.id)
    && isCapabilityText(value.kind)
    && isRuntimeScopeKind(value.scopeKind)
    && validateRuntimeScope(value.scope) === null
    && value.scope.kind === value.scopeKind
    && Array.isArray(value.targetKinds)
    && value.targetKinds.every(isCapabilityText)
    && isCapabilitySupportLevel(value.supportLevel)
    && isCapabilityAvailability(value.availability)
    && Array.isArray(value.operations)
    && value.operations.every(isCapabilityOperation)
    && isCapabilityText(value.policyScope)
    && isCapabilityText(value.ownerModuleId)
    && isCapabilityText(value.routeOwnerId)
    && optionalCapabilityText(value.runtimeAdapterId)
    && optionalCapabilityText(value.runtimeInstanceId)
    && optionalCapabilityText(value.protocolId)
    && optionalCapabilityText(value.connectorId)
    && optionalCapabilityText(value.endpointId)
    && optionalCapabilityTextArray(value.targetAgentIds);
}

function isCapabilityOperation(value: unknown): boolean {
  return isRecord(value)
    && hasOnlyKeys(value, ['id', 'title', 'targetKind', 'targetRequired'])
    && Object.hasOwn(value, 'id')
    && Object.hasOwn(value, 'title')
    && Object.hasOwn(value, 'targetKind')
    && isCapabilityText(value.id)
    && isCapabilityText(value.title)
    && isCapabilityText(value.targetKind)
    && (value.targetRequired === undefined || typeof value.targetRequired === 'boolean');
}

function isPublicFailure(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['success', 'error'])
    && value.success === false
    && typeof value.error === 'string';
}

function sameRuntimeScope(left: RuntimeScope, right: RuntimeScope): boolean {
  try {
    return buildCapabilityScopeKey(left) === buildCapabilityScopeKey(right);
  } catch {
    return false;
  }
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isRuntimeScopeKind(value: unknown): value is RuntimeScope['kind'] {
  return value === 'app'
    || value === 'runtime-instance'
    || value === 'agent'
    || value === 'session'
    || value === 'workspace'
    || value === 'team-run'
    || value === 'provider-routing';
}

function isCapabilitySupportLevel(value: unknown): boolean {
  return value === 'native'
    || value === 'projected'
    || value === 'emulated'
    || value === 'readonly'
    || value === 'unsupported';
}

function isCapabilityAvailability(value: unknown): boolean {
  return value === 'available' || value === 'unavailable';
}

function isCapabilityText(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && !hasControlCharacter(value);
}

function optionalCapabilityText(value: unknown): value is string | undefined {
  return value === undefined || isCapabilityText(value);
}

function optionalCapabilityTextArray(value: unknown): value is string[] | undefined {
  return value === undefined || Array.isArray(value) && value.every(isCapabilityText);
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code >= 0 && code <= 31) || code === 127) return true;
  }
  return false;
}
