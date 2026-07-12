import type {
  RemoteCapabilitySnapshotRecord,
  RemoteFleetAuditEventRecord,
  RemoteFleetCommandRecord,
  RemoteFleetConnectionRecord,
  RemoteFleetCredentialWriteOperationRecord,
  RemoteFleetEnvironmentRecord,
  RemoteFleetLeaseRecord,
  RemoteFleetManagedResourceRecord,
  RemoteFleetNodeRecord,
  RemoteFleetTerminalSessionRecord,
  RemoteRuntimeEndpointRecord,
  RuntimeAgentRecord,
  RuntimeInstanceRecord,
} from './remote-fleet-model';

export interface RemoteFleetPersistedState {
  readonly version: 1;
  readonly connections: readonly RemoteFleetConnectionRecord[];
  readonly environments: readonly RemoteFleetEnvironmentRecord[];
  readonly managedResources: readonly RemoteFleetManagedResourceRecord[];
  readonly nodes: readonly RemoteFleetNodeRecord[];
  readonly agents: readonly RuntimeAgentRecord[];
  readonly runtimes: readonly RuntimeInstanceRecord[];
  readonly endpoints: readonly RemoteRuntimeEndpointRecord[];
  readonly capabilities: readonly RemoteCapabilitySnapshotRecord[];
  readonly commands: readonly RemoteFleetCommandRecord[];
  readonly credentialWriteOperations?: readonly RemoteFleetCredentialWriteOperationRecord[];
  readonly leases: readonly RemoteFleetLeaseRecord[];
  readonly sessions: readonly RemoteFleetTerminalSessionRecord[];
  readonly auditEvents: readonly RemoteFleetAuditEventRecord[];
}

export interface RemoteFleetStateStore {
  readState(): Promise<RemoteFleetPersistedState | null>;
  writeState(state: RemoteFleetPersistedState): Promise<void>;
}

export function emptyRemoteFleetPersistedState(): RemoteFleetPersistedState {
  return {
    version: 1,
    connections: [],
    environments: [],
    managedResources: [],
    nodes: [],
    agents: [],
    runtimes: [],
    endpoints: [],
    capabilities: [],
    commands: [],
    credentialWriteOperations: [],
    leases: [],
    sessions: [],
    auditEvents: [],
  };
}

export function deserializeRemoteFleetPersistedState(value: unknown): RemoteFleetPersistedState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return emptyRemoteFleetPersistedState();
  }
  const record = value as Partial<RemoteFleetPersistedState>;
  return {
    version: 1,
    connections: readPersistedRecordCollection<RemoteFleetConnectionRecord>(record.connections),
    environments: readPersistedRecordCollection<RemoteFleetEnvironmentRecord>(record.environments),
    managedResources: readPersistedRecordCollection<RemoteFleetManagedResourceRecord>(record.managedResources),
    nodes: readPersistedRecordCollection<RemoteFleetNodeRecord>(record.nodes),
    agents: readPersistedRecordCollection<RuntimeAgentRecord>(record.agents),
    runtimes: readPersistedRecordCollection<RuntimeInstanceRecord>(record.runtimes),
    endpoints: readPersistedRecordCollection<RemoteRuntimeEndpointRecord>(record.endpoints),
    capabilities: readPersistedRecordCollection<RemoteCapabilitySnapshotRecord>(record.capabilities),
    commands: readPersistedRecordCollection<RemoteFleetCommandRecord>(record.commands),
    credentialWriteOperations: readPersistedRecordCollection<RemoteFleetCredentialWriteOperationRecord>(record.credentialWriteOperations),
    leases: readPersistedRecordCollection<RemoteFleetLeaseRecord>(record.leases),
    sessions: readPersistedRecordCollection<RemoteFleetTerminalSessionRecord>(record.sessions),
    auditEvents: readPersistedRecordCollection<RemoteFleetAuditEventRecord>(record.auditEvents),
  };
}

function readPersistedRecordCollection<T extends { readonly id: string }>(value: unknown): readonly T[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is T => isPersistedRecordWithId(item));
}

function isPersistedRecordWithId(value: unknown): value is { readonly id: string } {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && 'id' in value
    && typeof value.id === 'string'
    && value.id.trim().length > 0;
}
