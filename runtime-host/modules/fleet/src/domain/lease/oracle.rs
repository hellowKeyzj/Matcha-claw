use std::{collections::BTreeMap, fmt, time::SystemTime};

use super::{
    Lease, LeaseDuration, LeaseId, LeaseOwner,
    record::{LeaseTimeError, ReleaseTransition, RenewTransition},
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Capacity {
    maximum: usize,
}

impl Capacity {
    /// Creates a positive capacity limit for one endpoint.
    ///
    /// # Errors
    ///
    /// Returns [`InvalidCapacity`] when `maximum` is zero.
    pub const fn try_new(maximum: usize) -> Result<Self, InvalidCapacity> {
        if maximum == 0 {
            return Err(InvalidCapacity);
        }
        Ok(Self { maximum })
    }

    pub const fn maximum(self) -> usize {
        self.maximum
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidCapacity;

impl fmt::Display for InvalidCapacity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("endpoint capacity must be greater than zero")
    }
}

impl std::error::Error for InvalidCapacity {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CapacityStatus {
    Available {
        active_lease_count: usize,
        available_lease_count: usize,
    },
    Exhausted {
        active_lease_count: usize,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RestoreLeaseError {
    DuplicateLeaseId,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LeaseBook<E> {
    leases: BTreeMap<LeaseId, Lease<E>>,
}

impl<E> Default for LeaseBook<E> {
    fn default() -> Self {
        Self {
            leases: BTreeMap::new(),
        }
    }
}

impl<E: PartialEq> LeaseBook<E> {
    pub fn restore(leases: Vec<Lease<E>>) -> Result<Self, RestoreLeaseError> {
        let mut book = Self::default();
        for lease in leases {
            if book.leases.insert(lease.id().clone(), lease).is_some() {
                return Err(RestoreLeaseError::DuplicateLeaseId);
            }
        }
        Ok(book)
    }

    /// Atomically checks capacity and records a new endpoint lease.
    pub fn acquire(
        &mut self,
        id: LeaseId,
        endpoint: E,
        owner: LeaseOwner,
        acquired_at: SystemTime,
        duration: LeaseDuration,
        capacity: Capacity,
    ) -> AcquireOutcome {
        if acquired_at.checked_add(duration.duration()).is_none() {
            return AcquireOutcome::ExpiryOutOfRange;
        }
        self.expire(acquired_at);
        if self.leases.contains_key(&id) {
            return AcquireOutcome::DuplicateLeaseId(id);
        }

        let active_lease_count = self.active_lease_count(&endpoint, acquired_at);
        if active_lease_count >= capacity.maximum() {
            return AcquireOutcome::Exhausted {
                active_lease_count,
                capacity,
            };
        }

        let lease = match Lease::try_acquire(id.clone(), endpoint, owner, acquired_at, duration) {
            Ok(lease) => lease,
            Err(LeaseTimeError::ExpiryOutOfRange) => return AcquireOutcome::ExpiryOutOfRange,
        };
        self.leases.insert(id, lease);
        AcquireOutcome::Acquired
    }

    pub fn lease(&self, id: &LeaseId) -> Option<&Lease<E>> {
        self.leases.get(id)
    }

    pub fn active_lease_count(&self, endpoint: &E, now: SystemTime) -> usize {
        self.leases
            .values()
            .filter(|lease| lease.endpoint() == endpoint && lease.is_active_at(now))
            .count()
    }

    pub fn capacity(&self, endpoint: &E, capacity: Capacity, now: SystemTime) -> CapacityStatus {
        let active_lease_count = self.active_lease_count(endpoint, now);
        if active_lease_count < capacity.maximum() {
            CapacityStatus::Available {
                active_lease_count,
                available_lease_count: capacity.maximum() - active_lease_count,
            }
        } else {
            CapacityStatus::Exhausted { active_lease_count }
        }
    }

    pub fn renew(
        &mut self,
        id: &LeaseId,
        owner: &LeaseOwner,
        renewed_at: SystemTime,
        duration: LeaseDuration,
    ) -> RenewOutcome {
        let Some(lease) = self.leases.get_mut(id) else {
            return RenewOutcome::UnknownLease;
        };
        if lease.owner() != owner {
            return RenewOutcome::OwnerMismatch;
        }

        match lease.renew(renewed_at, duration) {
            Ok(RenewTransition::Renewed) => RenewOutcome::Renewed,
            Ok(RenewTransition::Expired) => RenewOutcome::Expired,
            Ok(RenewTransition::NotActive) => RenewOutcome::NotActive,
            Err(LeaseTimeError::ExpiryOutOfRange) => RenewOutcome::ExpiryOutOfRange,
        }
    }

    pub fn release(
        &mut self,
        id: &LeaseId,
        owner: &LeaseOwner,
        released_at: SystemTime,
    ) -> ReleaseOutcome {
        let Some(lease) = self.leases.get_mut(id) else {
            return ReleaseOutcome::UnknownLease;
        };
        if lease.owner() != owner {
            return ReleaseOutcome::OwnerMismatch;
        }

        match lease.release(released_at) {
            ReleaseTransition::Released => ReleaseOutcome::Released,
            ReleaseTransition::Expired => ReleaseOutcome::Expired,
            ReleaseTransition::NotActive => ReleaseOutcome::NotActive,
        }
    }

    pub fn release_endpoint(&mut self, endpoint: &E, released_at: SystemTime) -> Vec<LeaseId> {
        self.leases
            .values_mut()
            .filter(|lease| lease.endpoint() == endpoint)
            .filter_map(|lease| match lease.release(released_at) {
                ReleaseTransition::Released => Some(lease.id().clone()),
                ReleaseTransition::Expired | ReleaseTransition::NotActive => None,
            })
            .collect()
    }

    pub fn expire(&mut self, now: SystemTime) -> Vec<LeaseId> {
        self.leases
            .values_mut()
            .filter_map(|lease| lease.expire(now).then(|| lease.id().clone()))
            .collect()
    }

    pub fn leases(&self) -> impl Iterator<Item = &Lease<E>> {
        self.leases.values()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AcquireOutcome {
    Acquired,
    DuplicateLeaseId(LeaseId),
    Exhausted {
        active_lease_count: usize,
        capacity: Capacity,
    },
    ExpiryOutOfRange,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RenewOutcome {
    Renewed,
    UnknownLease,
    OwnerMismatch,
    Expired,
    NotActive,
    ExpiryOutOfRange,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReleaseOutcome {
    Released,
    UnknownLease,
    OwnerMismatch,
    Expired,
    NotActive,
}
