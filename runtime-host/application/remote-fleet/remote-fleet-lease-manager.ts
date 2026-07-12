import type { RemoteFleetLeaseRecord } from './remote-fleet-model';

export interface CountActiveRemoteFleetLeasesInput {
  readonly leases: readonly RemoteFleetLeaseRecord[];
  readonly endpointId: string;
  readonly now: string;
}

export interface RemoteFleetLeaseCapacityInput {
  readonly leases: readonly RemoteFleetLeaseRecord[];
  readonly endpointId: string;
  readonly now: string;
  readonly maxLeaseCount: number;
}

export type RemoteFleetLeaseCapacityExplanation =
  | {
      readonly reason: 'available';
      readonly endpointId: string;
      readonly activeLeaseCount: number;
      readonly maxLeaseCount: number;
      readonly availableLeaseCount: number;
    }
  | {
      readonly reason: 'exhausted';
      readonly endpointId: string;
      readonly activeLeaseCount: number;
      readonly maxLeaseCount: number;
    };

export interface AcquireRemoteFleetLeaseRecordInput {
  readonly leaseId: string;
  readonly endpointId: string;
  readonly ownerKind: RemoteFleetLeaseRecord['ownerKind'];
  readonly ownerId: string;
  readonly now: string;
  readonly ttlMs: number;
}

export interface ReleaseRemoteFleetLeaseRecordsForEndpointInput {
  readonly leases: readonly RemoteFleetLeaseRecord[];
  readonly endpointId: string;
  readonly now: string;
}

export interface ReleaseRemoteFleetLeaseRecordsForEndpointResult {
  readonly records: readonly RemoteFleetLeaseRecord[];
  readonly releasedRecords: readonly RemoteFleetLeaseRecord[];
}

export interface ExpireRemoteFleetLeasesInput {
  readonly leases: readonly RemoteFleetLeaseRecord[];
  readonly now: string;
}

export interface ExpireRemoteFleetLeasesResult {
  readonly records: readonly RemoteFleetLeaseRecord[];
  readonly expiredRecords: readonly RemoteFleetLeaseRecord[];
}

export function countActiveLeases(input: CountActiveRemoteFleetLeasesInput): number {
  const nowMs = Date.parse(input.now);
  return input.leases.filter((lease) => isActiveLeaseForEndpointAt(lease, input.endpointId, nowMs)).length;
}

export function explainCapacity(input: RemoteFleetLeaseCapacityInput): RemoteFleetLeaseCapacityExplanation {
  const activeLeaseCount = countActiveLeases(input);
  if (activeLeaseCount < input.maxLeaseCount) {
    return {
      reason: 'available',
      endpointId: input.endpointId,
      activeLeaseCount,
      maxLeaseCount: input.maxLeaseCount,
      availableLeaseCount: input.maxLeaseCount - activeLeaseCount,
    };
  }

  return {
    reason: 'exhausted',
    endpointId: input.endpointId,
    activeLeaseCount,
    maxLeaseCount: input.maxLeaseCount,
  };
}

export function canAcquireLease(input: RemoteFleetLeaseCapacityInput): boolean {
  return explainCapacity(input).reason === 'available';
}

export function acquireLeaseRecord(input: AcquireRemoteFleetLeaseRecordInput): RemoteFleetLeaseRecord {
  return {
    id: input.leaseId,
    endpointId: input.endpointId,
    ownerKind: input.ownerKind,
    ownerId: input.ownerId,
    state: {
      reason: 'active',
      acquiredAt: input.now,
      expiresAt: new Date(Date.parse(input.now) + input.ttlMs).toISOString(),
    },
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function releaseLeaseRecordsForEndpoint(
  input: ReleaseRemoteFleetLeaseRecordsForEndpointInput,
): ReleaseRemoteFleetLeaseRecordsForEndpointResult {
  const records: RemoteFleetLeaseRecord[] = [];
  const releasedRecords: RemoteFleetLeaseRecord[] = [];

  for (const lease of input.leases) {
    if (lease.endpointId !== input.endpointId || lease.state.reason !== 'active') {
      records.push(lease);
      continue;
    }

    const releasedRecord: RemoteFleetLeaseRecord = {
      ...lease,
      state: { reason: 'released', releasedAt: input.now },
      updatedAt: input.now,
    };
    records.push(releasedRecord);
    releasedRecords.push(releasedRecord);
  }

  return { records, releasedRecords };
}

export function expireLeases(input: ExpireRemoteFleetLeasesInput): ExpireRemoteFleetLeasesResult {
  const nowMs = Date.parse(input.now);
  const records: RemoteFleetLeaseRecord[] = [];
  const expiredRecords: RemoteFleetLeaseRecord[] = [];

  for (const lease of input.leases) {
    if (lease.state.reason !== 'active' || Date.parse(lease.state.expiresAt) > nowMs) {
      records.push(lease);
      continue;
    }

    const expiredRecord: RemoteFleetLeaseRecord = {
      ...lease,
      state: { reason: 'expired', expiredAt: input.now },
      updatedAt: input.now,
    };
    records.push(expiredRecord);
    expiredRecords.push(expiredRecord);
  }

  return { records, expiredRecords };
}

function isActiveLeaseForEndpointAt(lease: RemoteFleetLeaseRecord, endpointId: string, nowMs: number): boolean {
  return lease.endpointId === endpointId && lease.state.reason === 'active' && Date.parse(lease.state.expiresAt) > nowMs;
}
