import {
  buildCapabilityScopeKey,
  validateRuntimeScope,
  type RuntimeScope,
} from '../../agent-runtime/contracts/runtime-address';
import type { CapabilityDescriptor } from './capability-descriptor';

function assertCapabilityDescriptorMetadata(descriptor: CapabilityDescriptor): void {
  if (typeof descriptor.policyScope !== 'string' || !descriptor.policyScope.trim()) {
    throw new Error('Capability descriptor policyScope is required');
  }
  if (typeof descriptor.ownerModuleId !== 'string' || !descriptor.ownerModuleId.trim()) {
    throw new Error('Capability descriptor ownerModuleId is required');
  }
  if (typeof descriptor.routeOwnerId !== 'string' || !descriptor.routeOwnerId.trim()) {
    throw new Error('Capability descriptor routeOwnerId is required');
  }
  if (descriptor.scope.kind !== descriptor.scopeKind) {
    throw new Error('Capability descriptor scopeKind does not match scope kind');
  }
  const scopeError = validateRuntimeScope(descriptor.scope);
  if (scopeError) {
    throw new Error(scopeError);
  }
  if (descriptor.operations.length === 0) {
    throw new Error('Capability descriptor operations are required');
  }
  if (descriptor.targetKinds.length === 0) {
    throw new Error('Capability descriptor targetKinds are required');
  }
  for (const operation of descriptor.operations) {
    if (!operation.id.trim()) {
      throw new Error('Capability operation id is required');
    }
    if (!descriptor.targetKinds.includes(operation.targetKind)) {
      throw new Error(`Capability operation targetKind is not declared: ${operation.id}`);
    }
  }
}

function isSameRuntimeEndpointScope(left: RuntimeScope, right: RuntimeScope): boolean {
  if ('endpoint' in left && 'endpoint' in right) {
    return buildRuntimeEndpointScopeKey(left) === buildRuntimeEndpointScopeKey(right);
  }
  if (left.kind === 'session' && right.kind === 'session') {
    return buildRuntimeEndpointScopeKey({ kind: 'runtime-instance', endpoint: left.identity.endpoint })
      === buildRuntimeEndpointScopeKey({ kind: 'runtime-instance', endpoint: right.identity.endpoint });
  }
  if (left.kind === 'team-run' && right.kind === 'team-run') {
    return buildRuntimeEndpointScopeKey(left) === buildRuntimeEndpointScopeKey(right);
  }
  return left.kind === right.kind;
}

function buildRuntimeEndpointScopeKey(scope: Extract<RuntimeScope, { endpoint: unknown }>): string {
  return scope.endpoint.kind === 'native-runtime'
    ? `native-runtime:${scope.endpoint.runtimeAdapterId}:${scope.endpoint.runtimeInstanceId}`
    : `protocol-connector:${scope.endpoint.protocolId}:${scope.endpoint.connectorId}:${scope.endpoint.endpointId}`;
}

export class CapabilityRegistry {
  private readonly descriptors = new Map<string, CapabilityDescriptor>();

  register(descriptor: CapabilityDescriptor): void {
    assertCapabilityDescriptorMetadata(descriptor);
    const key = this.buildDescriptorKey(descriptor);
    if (this.descriptors.has(key)) {
      throw new Error(`Capability already registered: ${key}`);
    }
    this.descriptors.set(key, descriptor);
  }

  registerMany(descriptors: Iterable<CapabilityDescriptor>): void {
    for (const descriptor of descriptors) {
      this.register(descriptor);
    }
  }

  replaceForRuntimeEndpointScope(scope: RuntimeScope, descriptors: Iterable<CapabilityDescriptor>): void {
    this.removeForRuntimeEndpointScope(scope);
    this.registerMany(descriptors);
  }

  removeForRuntimeEndpointScope(scope: RuntimeScope): void {
    for (const key of Array.from(this.descriptors.keys())) {
      const descriptor = this.descriptors.get(key)!;
      if (isSameRuntimeEndpointScope(descriptor.scope, scope)) {
        this.descriptors.delete(key);
      }
    }
  }

  list(): CapabilityDescriptor[] {
    return Array.from(this.descriptors.values());
  }

  listByCapability(capabilityId: string): CapabilityDescriptor[] {
    return this.list().filter((descriptor) => descriptor.id === capabilityId);
  }

  get(descriptor: Pick<CapabilityDescriptor, 'id' | 'scope'>): CapabilityDescriptor {
    const key = this.buildDescriptorKey(descriptor);
    const found = this.descriptors.get(key);
    if (!found) {
      throw new Error(`Capability not registered: ${key}`);
    }
    return found;
  }

  private buildDescriptorKey(descriptor: Pick<CapabilityDescriptor, 'id' | 'scope'>): string {
    return `${descriptor.id}:${buildCapabilityScopeKey(descriptor.scope)}`;
  }
}
