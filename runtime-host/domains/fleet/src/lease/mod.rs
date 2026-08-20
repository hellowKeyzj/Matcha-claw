mod identity;
mod oracle;
mod record;

pub use identity::{
    InvalidLeaseDuration, InvalidLeaseId, InvalidLeaseOwner, LeaseDuration, LeaseId, LeaseOwner,
    LeaseOwnerKind,
};
pub use oracle::{
    AcquireOutcome, Capacity, CapacityStatus, InvalidCapacity, LeaseBook, ReleaseOutcome,
    RenewOutcome, RestoreLeaseError,
};
pub use record::{Lease, LeaseState, LeaseTimeError};

#[cfg(test)]
mod tests {
    use std::time::{Duration, SystemTime};

    use super::*;

    fn at(seconds: u64) -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_secs(seconds)
    }

    fn duration(seconds: u64) -> LeaseDuration {
        LeaseDuration::try_new(Duration::from_secs(seconds)).unwrap()
    }

    fn capacity(maximum: usize) -> Capacity {
        Capacity::try_new(maximum).unwrap()
    }

    fn owner(id: &str) -> LeaseOwner {
        LeaseOwner::try_new(LeaseOwnerKind::TeamRun, id).unwrap()
    }

    fn acquire<'a>(book: &mut LeaseBook<&'a str>, id: &str, endpoint: &'a str, owner: &LeaseOwner) {
        assert_eq!(
            book.acquire(
                LeaseId::try_new(id).unwrap(),
                endpoint,
                owner.clone(),
                at(10),
                duration(5),
                capacity(3),
            ),
            AcquireOutcome::Acquired
        );
    }

    #[test]
    fn rejects_blank_identities_zero_duration_and_zero_capacity_without_echoing_them() {
        assert_eq!(
            LeaseId::try_new(" \t").unwrap_err().to_string(),
            "lease ID must not be empty"
        );
        assert_eq!(
            LeaseOwner::try_new(LeaseOwnerKind::Session, "\n")
                .unwrap_err()
                .to_string(),
            "lease owner ID must not be empty"
        );
        assert_eq!(
            LeaseDuration::try_new(Duration::ZERO).unwrap_err(),
            InvalidLeaseDuration
        );
        assert_eq!(Capacity::try_new(0).unwrap_err(), InvalidCapacity);
    }

    #[test]
    fn preserves_explicit_lease_owner_kind_and_identity() {
        let owner = LeaseOwner::try_new(LeaseOwnerKind::RuntimeStart, "runtime-1").unwrap();

        assert_eq!(owner.kind(), LeaseOwnerKind::RuntimeStart);
        assert_eq!(owner.id(), "runtime-1");
    }

    #[test]
    fn atomically_acquires_only_when_endpoint_capacity_is_available() {
        let mut book = LeaseBook::default();
        let first_owner = owner("run-1");
        let second_owner = owner("run-2");
        let exhausted_owner = owner("run-3");

        assert_eq!(
            book.acquire(
                LeaseId::try_new("lease-1").unwrap(),
                "endpoint-a",
                first_owner.clone(),
                at(10),
                duration(5),
                capacity(2),
            ),
            AcquireOutcome::Acquired
        );
        assert_eq!(
            book.acquire(
                LeaseId::try_new("lease-2").unwrap(),
                "endpoint-a",
                second_owner,
                at(10),
                duration(5),
                capacity(2),
            ),
            AcquireOutcome::Acquired
        );
        assert_eq!(
            book.acquire(
                LeaseId::try_new("lease-3").unwrap(),
                "endpoint-a",
                exhausted_owner,
                at(10),
                duration(5),
                capacity(2),
            ),
            AcquireOutcome::Exhausted {
                active_lease_count: 2,
                capacity: capacity(2),
            }
        );
        assert_eq!(book.active_lease_count(&"endpoint-a", at(10)), 2);
        assert!(book.lease(&LeaseId::try_new("lease-3").unwrap()).is_none());
        assert_eq!(
            book.lease(&LeaseId::try_new("lease-1").unwrap())
                .unwrap()
                .owner(),
            &first_owner
        );
    }

    #[test]
    fn duplicate_lease_identity_does_not_replace_existing_owner_or_consume_capacity() {
        let mut book = LeaseBook::default();
        let original_owner = owner("run-1");
        let duplicate_owner = owner("run-2");
        acquire(&mut book, "lease-1", "endpoint-a", &original_owner);

        assert_eq!(
            book.acquire(
                LeaseId::try_new("lease-1").unwrap(),
                "endpoint-b",
                duplicate_owner,
                at(10),
                duration(5),
                capacity(1),
            ),
            AcquireOutcome::DuplicateLeaseId(LeaseId::try_new("lease-1").unwrap())
        );
        assert_eq!(book.active_lease_count(&"endpoint-a", at(10)), 1);
        assert_eq!(book.active_lease_count(&"endpoint-b", at(10)), 0);
        assert_eq!(
            book.lease(&LeaseId::try_new("lease-1").unwrap())
                .unwrap()
                .owner(),
            &original_owner
        );
    }

    #[test]
    fn acquisition_expires_at_the_deadline_before_reusing_capacity() {
        let mut book = LeaseBook::default();
        let first_owner = owner("run-1");
        let second_owner = owner("run-2");
        acquire(&mut book, "expired", "endpoint-a", &first_owner);

        assert_eq!(
            book.acquire(
                LeaseId::try_new("replacement").unwrap(),
                "endpoint-a",
                second_owner,
                at(15),
                duration(5),
                capacity(1),
            ),
            AcquireOutcome::Acquired
        );
        assert_eq!(
            book.lease(&LeaseId::try_new("expired").unwrap())
                .unwrap()
                .state(),
            LeaseState::Expired { expired_at: at(15) }
        );
    }

    #[test]
    fn renewal_requires_the_current_owner_and_a_live_lease() {
        let mut book = LeaseBook::default();
        let lease_owner = owner("run-1");
        let another_owner = owner("run-2");
        let id = LeaseId::try_new("lease-1").unwrap();
        acquire(&mut book, "lease-1", "endpoint-a", &lease_owner);

        assert_eq!(
            book.renew(&id, &another_owner, at(12), duration(10)),
            RenewOutcome::OwnerMismatch
        );
        assert_eq!(
            book.renew(&id, &lease_owner, at(12), duration(10)),
            RenewOutcome::Renewed
        );
        assert_eq!(
            book.lease(&id).unwrap().state(),
            LeaseState::Active { expires_at: at(22) }
        );
        assert_eq!(
            book.renew(&id, &lease_owner, at(22), duration(10)),
            RenewOutcome::Expired
        );
        assert_eq!(
            book.lease(&id).unwrap().state(),
            LeaseState::Expired { expired_at: at(22) }
        );
    }

    #[test]
    fn release_is_owner_scoped_terminal_and_does_not_rewrite_an_expired_lease() {
        let mut book = LeaseBook::default();
        let lease_owner = owner("run-1");
        let another_owner = owner("run-2");
        let active_id = LeaseId::try_new("active").unwrap();
        let expired_id = LeaseId::try_new("expired").unwrap();
        acquire(&mut book, "active", "endpoint-a", &lease_owner);
        acquire(&mut book, "expired", "endpoint-b", &lease_owner);

        assert_eq!(
            book.release(&active_id, &another_owner, at(12)),
            ReleaseOutcome::OwnerMismatch
        );
        assert_eq!(
            book.release(&active_id, &lease_owner, at(12)),
            ReleaseOutcome::Released
        );
        assert_eq!(
            book.release(&active_id, &lease_owner, at(12)),
            ReleaseOutcome::NotActive
        );
        assert_eq!(book.expire(at(15)), vec![expired_id.clone()]);
        assert_eq!(
            book.release(&expired_id, &lease_owner, at(16)),
            ReleaseOutcome::NotActive
        );
        assert_eq!(
            book.lease(&active_id).unwrap().state(),
            LeaseState::Released {
                released_at: at(12)
            }
        );
        assert_eq!(
            book.lease(&expired_id).unwrap().state(),
            LeaseState::Expired { expired_at: at(15) }
        );
    }

    #[test]
    fn endpoint_release_changes_only_active_leases_for_the_selected_endpoint() {
        let mut book = LeaseBook::default();
        let lease_owner = owner("run-1");
        acquire(&mut book, "a", "endpoint-a", &lease_owner);
        acquire(&mut book, "b", "endpoint-b", &lease_owner);

        assert_eq!(
            book.release_endpoint(&"endpoint-a", at(12)),
            vec![LeaseId::try_new("a").unwrap()]
        );
        assert_eq!(
            book.lease(&LeaseId::try_new("a").unwrap()).unwrap().state(),
            LeaseState::Released {
                released_at: at(12)
            }
        );
        assert!(matches!(
            book.lease(&LeaseId::try_new("b").unwrap()).unwrap().state(),
            LeaseState::Active { .. }
        ));
    }

    #[test]
    fn capacity_projection_uses_the_same_live_lease_boundary_as_acquisition() {
        let mut book = LeaseBook::default();
        let lease_owner = owner("run-1");
        acquire(&mut book, "a", "endpoint-a", &lease_owner);
        acquire(&mut book, "b", "endpoint-a", &lease_owner);

        assert_eq!(
            book.capacity(&"endpoint-a", capacity(3), at(12)),
            CapacityStatus::Available {
                active_lease_count: 2,
                available_lease_count: 1,
            }
        );
        assert_eq!(
            book.capacity(&"endpoint-a", capacity(2), at(12)),
            CapacityStatus::Exhausted {
                active_lease_count: 2,
            }
        );
    }

    #[test]
    fn overflow_does_not_create_or_extend_a_lease() {
        let mut book = LeaseBook::default();
        let lease_owner = owner("run-1");
        let overflowing_duration = LeaseDuration::try_new(Duration::MAX).unwrap();
        let near_limit = SystemTime::UNIX_EPOCH + Duration::from_secs(1);

        assert_eq!(
            book.acquire(
                LeaseId::try_new("overflow").unwrap(),
                "endpoint-a",
                lease_owner.clone(),
                near_limit,
                overflowing_duration,
                capacity(1),
            ),
            AcquireOutcome::ExpiryOutOfRange
        );
        assert!(book.lease(&LeaseId::try_new("overflow").unwrap()).is_none());

        acquire(&mut book, "lease-a", "endpoint-a", &lease_owner);
        assert_eq!(
            book.renew(
                &LeaseId::try_new("lease-a").unwrap(),
                &lease_owner,
                near_limit,
                overflowing_duration,
            ),
            RenewOutcome::ExpiryOutOfRange
        );
        assert_eq!(
            book.lease(&LeaseId::try_new("lease-a").unwrap())
                .unwrap()
                .state(),
            LeaseState::Active { expires_at: at(15) }
        );
    }
}
