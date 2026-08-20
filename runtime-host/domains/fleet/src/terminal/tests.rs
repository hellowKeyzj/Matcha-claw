use std::time::{Duration, SystemTime};

use super::*;

fn at(seconds: u64) -> SystemTime {
    SystemTime::UNIX_EPOCH + Duration::from_secs(seconds)
}
fn ids() -> (SessionId, TargetId, ProviderId) {
    (
        SessionId::try_new("session").unwrap(),
        TargetId::try_new("target").unwrap(),
        ProviderId::try_new("provider").unwrap(),
    )
}

#[test]
fn validates_dimensions_and_uses_one_based_generation() {
    assert!(Dimensions::try_new(0, 80).is_err());
    assert!(Dimensions::try_new(80, 1001).is_err());
    assert_eq!(Generation::FIRST.get(), 1);
}

#[test]
fn allocator_issues_opaque_monotonic_session_ids() {
    let mut allocator = SessionIdAllocator::default();
    assert_eq!(allocator.next().unwrap().as_str(), "terminal-session-1");
    assert_eq!(allocator.next().unwrap().as_str(), "terminal-session-2");
}

#[test]
fn owner_allocated_open_uses_owner_local_identity_source() {
    let target = TargetId::try_new("target").unwrap();
    let provider = ProviderId::try_new("provider").unwrap();
    let mut owner = TerminalSessionOwner::default();
    let opened = owner
        .open_allocated(
            target,
            provider,
            Dimensions::try_new(24, 80).unwrap(),
            at(10),
        )
        .unwrap();
    assert_eq!(opened.session.id().as_str(), "terminal-session-1");
    assert_eq!(owner.list()[0].id(), opened.session.id());
}

#[test]
fn ticket_is_one_time_generation_fenced_and_timing_safe() {
    let (id, target, provider) = ids();
    let mut owner = TerminalSessionOwner::default();
    let opened = owner
        .open(
            id,
            target,
            provider,
            Dimensions::try_new(24, 80).unwrap(),
            at(10),
        )
        .unwrap();
    assert!(
        owner
            .consume_ticket(
                opened.session.id().clone(),
                opened.session.generation(),
                opened.ticket.as_bytes(),
                at(10)
            )
            .is_ok()
    );
    assert!(
        owner
            .consume_ticket(
                opened.session.id().clone(),
                opened.session.generation(),
                opened.ticket.as_bytes(),
                at(10)
            )
            .is_err()
    );
}

#[test]
fn list_is_stable_and_lifecycle_states_are_projected() {
    let (id, target, provider) = ids();
    let second_id = SessionId::try_new("session-2").unwrap();
    let mut owner = TerminalSessionOwner::default();
    owner
        .open(
            id.clone(),
            target.clone(),
            provider.clone(),
            Dimensions::try_new(24, 80).unwrap(),
            at(10),
        )
        .unwrap();
    owner
        .open(
            second_id.clone(),
            target,
            provider,
            Dimensions::try_new(40, 120).unwrap(),
            at(11),
        )
        .unwrap();

    let listed = owner.list();
    assert_eq!(listed.len(), 2);
    assert_eq!(listed[0].id().as_str(), "session");
    assert_eq!(listed[0].status(), SessionStatus::Opening);
    assert_eq!(listed[1].id().as_str(), "session-2");

    let reconnected = owner.reconnect(id.clone(), at(12)).unwrap();
    assert_eq!(reconnected.session.status(), SessionStatus::Opening);
    assert_eq!(reconnected.session.generation().get(), 2);
    assert_eq!(owner.list()[0].generation().get(), 2);

    owner
        .consume_ticket(
            id.clone(),
            reconnected.session.generation(),
            reconnected.ticket.as_bytes(),
            at(12),
        )
        .unwrap();
    assert_eq!(owner.list()[0].status(), SessionStatus::Connected);
    owner
        .begin_close(&id, reconnected.session.generation(), at(13))
        .unwrap();
    assert_eq!(owner.list()[0].status(), SessionStatus::Closing);
    owner
        .finish_close(&id, reconnected.session.generation(), at(14))
        .unwrap();
    assert_eq!(owner.list()[0].status(), SessionStatus::Closed);
    assert_eq!(owner.list()[1].status(), SessionStatus::Opening);
}

#[test]
fn expiry_and_close_are_idempotent() {
    let (id, target, provider) = ids();
    let mut owner = TerminalSessionOwner::default();
    owner
        .open(
            id.clone(),
            target,
            provider,
            Dimensions::try_new(24, 80).unwrap(),
            at(10),
        )
        .unwrap();
    assert!(owner.expire(&id, at(40)).is_ok());
    assert!(owner.expire(&id, at(41)).is_err());
    assert!(owner.begin_close(&id, Generation::FIRST, at(42)).is_err());
}

#[test]
fn stale_generation_cannot_close_reconnected_session() {
    let (id, target, provider) = ids();
    let mut owner = TerminalSessionOwner::default();
    let opened = owner
        .open(
            id.clone(),
            target,
            provider,
            Dimensions::try_new(24, 80).unwrap(),
            at(10),
        )
        .unwrap();
    let reconnected = owner.reconnect(id.clone(), at(11)).unwrap();
    assert_eq!(reconnected.session.generation().get(), 2);
    assert!(
        owner
            .close(&id, opened.session.generation(), at(12))
            .is_err()
    );
    assert_eq!(
        owner.list()[0].generation(),
        reconnected.session.generation()
    );
    assert_eq!(owner.list()[0].status(), SessionStatus::Opening);
}

#[test]
fn stale_generation_cleanup_does_not_burn_reconnect_ticket() {
    let (id, target, provider) = ids();
    let mut owner = TerminalSessionOwner::default();
    let opened = owner
        .open(
            id.clone(),
            target,
            provider,
            Dimensions::try_new(24, 80).unwrap(),
            at(10),
        )
        .unwrap();
    let reconnected = owner.reconnect(id.clone(), at(11)).unwrap();

    assert!(
        owner
            .begin_close(&id, opened.session.generation(), at(12))
            .is_err()
    );
    let consumed = owner
        .consume_ticket(
            id.clone(),
            reconnected.session.generation(),
            reconnected.ticket.as_bytes(),
            at(13),
        )
        .unwrap();

    assert_eq!(consumed.generation(), reconnected.session.generation());
    assert_eq!(consumed.status(), SessionStatus::Connected);
}
