import { describe, expect, it } from 'vitest';
import {
  acquireLeaseRecord,
  canAcquireLease,
  countActiveLeases,
  explainCapacity,
  expireLeases,
  releaseLeaseRecordsForEndpoint,
} from '../../runtime-host/application/remote-fleet/remote-fleet-lease-manager';
import type { RemoteFleetLeaseRecord } from '../../runtime-host/application/remote-fleet/remote-fleet-model';

const NOW = '2026-07-06T12:00:00.000Z';
const EARLIER = '2026-07-06T11:00:00.000Z';
const LATER = '2026-07-06T13:00:00.000Z';

function activeLease(input: {
  readonly id: string;
  readonly endpointId: string;
  readonly expiresAt: string;
  readonly ownerKind?: RemoteFleetLeaseRecord['ownerKind'];
  readonly ownerId?: string;
}): RemoteFleetLeaseRecord {
  return {
    id: input.id,
    endpointId: input.endpointId,
    ownerKind: input.ownerKind ?? 'session',
    ownerId: input.ownerId ?? `owner-${input.id}`,
    state: { reason: 'active', acquiredAt: EARLIER, expiresAt: input.expiresAt },
    createdAt: EARLIER,
    updatedAt: EARLIER,
  };
}

describe('remote fleet lease manager', () => {
  it('counts only active non-expired leases for the selected endpoint', () => {
    const leases: RemoteFleetLeaseRecord[] = [
      activeLease({ id: 'lease-active', endpointId: 'endpoint-a', expiresAt: LATER }),
      activeLease({ id: 'lease-expired-at-now', endpointId: 'endpoint-a', expiresAt: NOW }),
      activeLease({ id: 'lease-other-endpoint', endpointId: 'endpoint-b', expiresAt: LATER }),
      {
        ...activeLease({ id: 'lease-released', endpointId: 'endpoint-a', expiresAt: LATER }),
        state: { reason: 'released', releasedAt: EARLIER },
      },
      {
        ...activeLease({ id: 'lease-expired', endpointId: 'endpoint-a', expiresAt: LATER }),
        state: { reason: 'expired', expiredAt: EARLIER },
      },
    ];

    expect(countActiveLeases({ leases, endpointId: 'endpoint-a', now: NOW })).toBe(1);
  });

  it('explains endpoint lease capacity and canAcquireLease through the same capacity path', () => {
    const leases = [
      activeLease({ id: 'lease-a', endpointId: 'endpoint-a', expiresAt: LATER }),
      activeLease({ id: 'lease-b', endpointId: 'endpoint-a', expiresAt: LATER }),
      activeLease({ id: 'lease-c', endpointId: 'endpoint-b', expiresAt: LATER }),
    ];

    expect(explainCapacity({ leases, endpointId: 'endpoint-a', now: NOW, maxLeaseCount: 3 })).toEqual({
      reason: 'available',
      endpointId: 'endpoint-a',
      activeLeaseCount: 2,
      maxLeaseCount: 3,
      availableLeaseCount: 1,
    });
    expect(canAcquireLease({ leases, endpointId: 'endpoint-a', now: NOW, maxLeaseCount: 3 })).toBe(true);

    expect(explainCapacity({ leases, endpointId: 'endpoint-a', now: NOW, maxLeaseCount: 2 })).toEqual({
      reason: 'exhausted',
      endpointId: 'endpoint-a',
      activeLeaseCount: 2,
      maxLeaseCount: 2,
    });
    expect(canAcquireLease({ leases, endpointId: 'endpoint-a', now: NOW, maxLeaseCount: 2 })).toBe(false);
  });

  it('acquires a lease record with explicit owner, timestamps, and ttl-derived expiry', () => {
    expect(acquireLeaseRecord({
      leaseId: 'lease-new',
      endpointId: 'endpoint-a',
      ownerKind: 'team-run',
      ownerId: 'run-1',
      now: NOW,
      ttlMs: 30_000,
    })).toEqual({
      id: 'lease-new',
      endpointId: 'endpoint-a',
      ownerKind: 'team-run',
      ownerId: 'run-1',
      state: {
        reason: 'active',
        acquiredAt: NOW,
        expiresAt: '2026-07-06T12:00:30.000Z',
      },
      createdAt: NOW,
      updatedAt: NOW,
    });
  });

  it('releases active leases for one endpoint and returns changed records explicitly', () => {
    const endpointLease = activeLease({ id: 'lease-a', endpointId: 'endpoint-a', expiresAt: LATER });
    const otherEndpointLease = activeLease({ id: 'lease-b', endpointId: 'endpoint-b', expiresAt: LATER });
    const alreadyExpiredLease: RemoteFleetLeaseRecord = {
      ...activeLease({ id: 'lease-c', endpointId: 'endpoint-a', expiresAt: LATER }),
      state: { reason: 'expired', expiredAt: EARLIER },
    };

    const result = releaseLeaseRecordsForEndpoint({
      leases: [endpointLease, otherEndpointLease, alreadyExpiredLease],
      endpointId: 'endpoint-a',
      now: NOW,
    });

    expect(result.releasedRecords).toEqual([{
      ...endpointLease,
      state: { reason: 'released', releasedAt: NOW },
      updatedAt: NOW,
    }]);
    expect(result.records).toEqual([
      result.releasedRecords[0],
      otherEndpointLease,
      alreadyExpiredLease,
    ]);
  });

  it('expires active leases whose ttl has elapsed and preserves released leases', () => {
    const expiredByTtlLease = activeLease({ id: 'lease-a', endpointId: 'endpoint-a', expiresAt: NOW });
    const activeFutureLease = activeLease({ id: 'lease-b', endpointId: 'endpoint-a', expiresAt: LATER });
    const releasedLease: RemoteFleetLeaseRecord = {
      ...activeLease({ id: 'lease-c', endpointId: 'endpoint-a', expiresAt: EARLIER }),
      state: { reason: 'released', releasedAt: EARLIER },
    };

    const result = expireLeases({ leases: [expiredByTtlLease, activeFutureLease, releasedLease], now: NOW });

    expect(result.expiredRecords).toEqual([{
      ...expiredByTtlLease,
      state: { reason: 'expired', expiredAt: NOW },
      updatedAt: NOW,
    }]);
    expect(result.records).toEqual([
      result.expiredRecords[0],
      activeFutureLease,
      releasedLease,
    ]);
  });
});
