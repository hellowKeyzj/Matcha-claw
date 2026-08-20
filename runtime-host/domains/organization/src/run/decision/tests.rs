use super::*;

fn command(key: &str, decision: TeamDecisionType) -> TeamDecisionCommand {
    TeamDecisionCommand::try_new(
        format!("decision-{key}"),
        "run-1",
        "stage-1",
        decision,
        Some("reviewed".to_owned()),
        key,
        100,
    )
    .unwrap()
}

#[test]
fn records_and_replays_only_an_exact_command() {
    let mut ledger = TeamDecisionLedger::default();
    let first = command("key-1", TeamDecisionType::Retry);
    let receipt = ledger.record(first.clone()).unwrap();
    assert!(!receipt.is_replay());
    assert_eq!(receipt.decision().sequence(), 1);
    assert!(ledger.record(first).unwrap().is_replay());
    assert_eq!(ledger.decisions_for_run("run-1").count(), 1);
}

#[test]
fn reused_key_with_different_decision_fails_closed() {
    let mut ledger = TeamDecisionLedger::default();
    ledger
        .record(command("key-1", TeamDecisionType::Retry))
        .unwrap();
    assert_eq!(
        ledger.record(command("key-1", TeamDecisionType::Abort)),
        Err(TeamDecisionRecordError::ConflictingIdempotencyKey)
    );
}

#[test]
fn durable_snapshot_restores_canonical_sequences() {
    let mut ledger = TeamDecisionLedger::default();
    ledger
        .record(command("key-1", TeamDecisionType::Retry))
        .unwrap();
    ledger
        .record(command("key-2", TeamDecisionType::ProceedDegraded))
        .unwrap();
    let snapshot = ledger.snapshot();
    let restored = TeamDecisionLedger::restore(snapshot).unwrap();
    let decisions: Vec<_> = restored.decisions_for_run("run-1").collect();
    assert_eq!(decisions.len(), 2);
    assert_eq!(decisions[0].decision(), TeamDecisionType::Retry);
    assert_eq!(decisions[1].decision(), TeamDecisionType::ProceedDegraded);
}

#[test]
fn restore_rejects_sequence_gaps() {
    let mut ledger = TeamDecisionLedger::default();
    ledger
        .record(command("key-1", TeamDecisionType::Abort))
        .unwrap();
    let mut snapshot = ledger.snapshot();
    snapshot.decisions[0].sequence = 2;
    assert_eq!(
        TeamDecisionLedger::restore(snapshot),
        Err(TeamDecisionLedgerRestoreError::SequenceGap)
    );
}
