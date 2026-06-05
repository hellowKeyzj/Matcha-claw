import {
  buildRuntimeAddressKey,
  validateRuntimeAddress,
  type RuntimeAddress,
} from '../../agent-runtime/contracts/runtime-address';
import type { CapabilityDescriptor } from './capability-descriptor';

function assertEqual(field: string, expected: string | undefined, actual: string | undefined): void {
  if (actual !== expected) {
    throw new Error(`Capability descriptor ${field} does not match RuntimeAddress`);
  }
}

function assertForbidden(field: string, actual: string | undefined, address: RuntimeAddress): void {
  if (actual !== undefined) {
    throw new Error(`Capability descriptor ${field} is not allowed for ${address.kind}`);
  }
}

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
  if (descriptor.operations.length === 0) {
    throw new Error('Capability descriptor operations are required');
  }
  for (const operation of descriptor.operations) {
    if (!operation.id.trim()) {
      throw new Error('Capability operation id is required');
    }
  }
}

function isSameRuntimeEndpointScope(left: RuntimeAddress, right: RuntimeAddress): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === 'native-runtime') {
    return left.runtimeAdapterId === right.runtimeAdapterId
      && left.runtimeInstanceId === right.runtimeInstanceId;
  }
  return left.protocolId === right.protocolId
    && left.connectorId === right.connectorId
    && left.endpointId === right.endpointId;
}

function assertCapabilityDescriptorAddress(descriptor: CapabilityDescriptor): void {
  assertCapabilityDescriptorMetadata(descriptor);
  const addressError = validateRuntimeAddress(descriptor.address);
  if (addressError) {
    throw new Error(addressError);
  }
  if (descriptor.id !== descriptor.address.capabilityId) {
    throw new Error('Capability descriptor id does not match RuntimeAddress capabilityId');
  }
  if (!descriptor.targetAgentIds.includes(descriptor.address.agentId)) {
    throw new Error('Capability descriptor targetAgentIds must include RuntimeAddress agentId');
  }
  if (descriptor.modelProviderId !== descriptor.address.modelProviderId) {
    throw new Error('Capability descriptor modelProviderId does not match RuntimeAddress');
  }

  if (descriptor.address.kind === 'native-runtime') {
    assertEqual('runtimeAdapterId', descriptor.address.runtimeAdapterId, descriptor.runtimeAdapterId);
    assertEqual('runtimeInstanceId', descriptor.address.runtimeInstanceId, descriptor.runtimeInstanceId);
    assertForbidden('protocolId', descriptor.protocolId, descriptor.address);
    assertForbidden('connectorId', descriptor.connectorId, descriptor.address);
    assertForbidden('endpointId', descriptor.endpointId, descriptor.address);
    return;
  }

  assertEqual('protocolId', descriptor.address.protocolId, descriptor.protocolId);
  assertEqual('connectorId', descriptor.address.connectorId, descriptor.connectorId);
  assertEqual('endpointId', descriptor.address.endpointId, descriptor.endpointId);
  assertForbidden('runtimeAdapterId', descriptor.runtimeAdapterId, descriptor.address);
  assertForbidden('runtimeInstanceId', descriptor.runtimeInstanceId, descriptor.address);
}

export class CapabilityRegistry {
  private readonly descriptors = new Map<string, CapabilityDescriptor>();

  register(descriptor: CapabilityDescriptor): void {
    assertCapabilityDescriptorAddress(descriptor);
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

  replaceForRuntimeEndpointScope(scope: RuntimeAddress, descriptors: Iterable<CapabilityDescriptor>): void {
    this.removeForRuntimeEndpointScope(scope);
    this.registerMany(descriptors);
  }

  removeForRuntimeEndpointScope(scope: RuntimeAddress): void {
    for (const key of Array.from(this.descriptors.keys())) {
      const descriptor = this.descriptors.get(key)!;
      if (isSameRuntimeEndpointScope(descriptor.address, scope)) {
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

  get(descriptor: Pick<CapabilityDescriptor, 'id' | 'address'>): CapabilityDescriptor {
    const key = this.buildDescriptorKey(descriptor);
    const found = this.descriptors.get(key);
    if (!found) {
      throw new Error(`Capability not registered: ${key}`);
    }
    return found;
  }

  private buildDescriptorKey(descriptor: Pick<CapabilityDescriptor, 'id' | 'address'>): string {
    return `${descriptor.id}:${buildRuntimeAddressKey(descriptor.address)}`;
  }
}
