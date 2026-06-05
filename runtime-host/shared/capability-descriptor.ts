import type { RuntimeAddress } from './runtime-address';

export type CapabilitySupportLevel = 'native' | 'projected' | 'emulated' | 'readonly' | 'unsupported';
export type CapabilityAvailability = 'available' | 'unavailable';

export interface CapabilityOperationDescriptor {
  id: string;
  title: string;
}

export interface CapabilityDescriptor {
  id: string;
  kind: string;
  address: RuntimeAddress;
  runtimeAdapterId?: string;
  runtimeInstanceId?: string;
  protocolId?: string;
  connectorId?: string;
  endpointId?: string;
  targetAgentIds: string[];
  modelProviderId?: string;
  supportLevel: CapabilitySupportLevel;
  availability: CapabilityAvailability;
  operations: CapabilityOperationDescriptor[];
  policyScope: string;
  ownerModuleId: string;
  routeOwnerId: string;
}
