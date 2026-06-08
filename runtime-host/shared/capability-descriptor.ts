import type { CapabilityTargetKind, RuntimeScope, RuntimeScopeKind } from './runtime-address';

export type CapabilitySupportLevel = 'native' | 'projected' | 'emulated' | 'readonly' | 'unsupported';
export type CapabilityAvailability = 'available' | 'unavailable';

export interface CapabilityOperationDescriptor {
  id: string;
  title: string;
  targetKind: CapabilityTargetKind;
  targetRequired?: boolean;
}

export interface CapabilityDescriptor {
  id: string;
  kind: string;
  scopeKind: RuntimeScopeKind;
  scope: RuntimeScope;
  targetKinds: CapabilityTargetKind[];
  runtimeAdapterId?: string;
  runtimeInstanceId?: string;
  protocolId?: string;
  connectorId?: string;
  endpointId?: string;
  targetAgentIds?: string[];
  supportLevel: CapabilitySupportLevel;
  availability: CapabilityAvailability;
  operations: CapabilityOperationDescriptor[];
  policyScope: string;
  ownerModuleId: string;
  routeOwnerId: string;
}
