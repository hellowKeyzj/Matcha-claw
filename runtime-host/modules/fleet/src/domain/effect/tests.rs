use std::time::{Duration, SystemTime};

use crate::{
    domain::command::{CommandAttempt, CommandId},
    domain::target::{FleetTargetSelector, TargetId, TargetKind},
};

use super::*;

fn record() -> EffectRecord {
    EffectRecord::new(
        CommandId::try_new("operation-1").unwrap(),
        PhaseKey::try_new("apply").unwrap(),
        FleetTargetSelector::new(
            TargetId::try_new("target-1").unwrap(),
            7,
            TargetKind::Docker,
        ),
        7,
        ProviderKind::Docker,
        SystemTime::UNIX_EPOCH + Duration::from_secs(10),
    )
}

#[test]
fn phase_keys_are_bounded_and_nul_free() {
    assert_eq!(PhaseKey::try_new(" ").unwrap_err(), InvalidPhaseKey::Empty);
    assert_eq!(
        PhaseKey::try_new("bad\0key").unwrap_err(),
        InvalidPhaseKey::ContainsNul
    );
    assert_eq!(
        PhaseKey::try_new("x".repeat(129)).unwrap_err(),
        InvalidPhaseKey::TooLong
    );
}

#[test]
fn receipts_are_fenced_and_duplicate_receipts_are_idempotent() {
    let mut effect = record();
    let EffectTransition::Began { attempt } = effect.begin().unwrap() else {
        panic!("begin must return the current attempt");
    };
    let stale = CommandAttempt::try_new(attempt.sequence() + 1).unwrap();
    assert_eq!(
        effect
            .apply_receipt(&EffectReceipt::delivered(stale))
            .unwrap_err(),
        EffectTransitionError::StaleAttempt
    );

    let receipt = EffectReceipt::delivered(attempt);
    assert_eq!(
        effect.apply_receipt(&receipt),
        Ok(EffectTransition::Delivered)
    );
    assert_eq!(
        effect.apply_receipt(&receipt),
        Ok(EffectTransition::Idempotent)
    );
}

#[test]
fn unknown_requires_explicit_replay_before_a_new_attempt() {
    let mut effect = record();
    let EffectTransition::Began { attempt: first } = effect.begin().unwrap() else {
        panic!("begin must return the current attempt");
    };
    assert_eq!(
        effect.expire(SystemTime::UNIX_EPOCH + Duration::from_secs(9)),
        Err(EffectTransitionError::DeadlineNotReached)
    );
    assert_eq!(
        effect.expire(SystemTime::UNIX_EPOCH + Duration::from_secs(10)),
        Ok(EffectTransition::OutcomeUnknown)
    );
    assert_eq!(
        effect.begin().unwrap_err(),
        EffectTransitionError::InvalidTransition
    );
    assert_eq!(
        effect.authorize_replay(),
        Ok(EffectTransition::ReplayAuthorized)
    );
    let EffectTransition::Began { attempt: second } = effect.begin().unwrap() else {
        panic!("replay must permit a new attempt");
    };
    assert_eq!(second.sequence(), first.sequence() + 1);
}

#[test]
fn provider_uncertainty_requires_fenced_replay_before_a_new_attempt() {
    let record = record();
    let identity = record.identity().clone();
    let mut ledger = EffectLedger::default();
    ledger.insert(record).unwrap();

    let EffectOperationOutcome::Applied {
        transition: EffectTransition::Began { attempt: first },
    } = ledger.begin(&identity)
    else {
        panic!("begin must return the current attempt");
    };
    let stale = CommandAttempt::try_new(first.sequence() + 1).unwrap();
    assert_eq!(
        ledger.mark_unknown(&identity, &stale),
        EffectOperationOutcome::Rejected(EffectTransitionError::StaleAttempt)
    );
    assert_eq!(
        ledger.mark_unknown(&identity, &first),
        EffectOperationOutcome::Applied {
            transition: EffectTransition::OutcomeUnknown,
        }
    );
    assert_eq!(
        ledger.begin(&identity),
        EffectOperationOutcome::Rejected(EffectTransitionError::InvalidTransition)
    );
    assert_eq!(
        ledger.replay(&identity),
        EffectOperationOutcome::Applied {
            transition: EffectTransition::ReplayAuthorized,
        }
    );
    let EffectOperationOutcome::Applied {
        transition: EffectTransition::Began { attempt: second },
    } = ledger.begin(&identity)
    else {
        panic!("replay must permit a new attempt");
    };
    assert_eq!(second.sequence(), first.sequence() + 1);
}
