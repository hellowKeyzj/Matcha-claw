use crate::ApprovalDecision;

use super::{
    ApprovalAction, ApprovalCommand, CommandPayload, CommandRejection, EventLedger, GraphNodeKind,
    GraphPatch, GraphPatchOperation, OpaqueId, RunCommand, TeamEventPayload, TeamEventType,
};

fn id(value: &str) -> OpaqueId {
    OpaqueId::try_new(value).unwrap()
}

fn graph_patch(run_id: &str, command_id: &str, key: &str, created_at: u64) -> RunCommand {
    let patch = GraphPatch::try_new(
        "graph-a",
        "plan-a",
        vec![GraphPatchOperation::AddNode {
            node_id: "node-a".to_owned(),
            kind: GraphNodeKind::Work,
            role_id: Some("role-a".to_owned()),
        }],
    )
    .unwrap();
    RunCommand::new(
        id(run_id),
        id(command_id),
        id(key),
        CommandPayload::GraphPatch(patch),
        created_at,
    )
}

fn approval(run_id: &str, command_id: &str, key: &str, created_at: u64) -> RunCommand {
    RunCommand::new(
        id(run_id),
        id(command_id),
        id(key),
        CommandPayload::ApprovalRequest(ApprovalCommand::new(
            id("approval-a"),
            id("node-review"),
            id("reviewer"),
            ApprovalAction::ContinueNode,
        )),
        created_at,
    )
}

#[test]
fn same_run_records_accepted_graph_patch_rejected_stale_node_and_accepted_approval_in_order() {
    let mut ledger = EventLedger::default();

    let graph_patch = ledger.accept(graph_patch("run-a", "command-patch", "key-patch", 10));
    let stale_node = ledger.reject(
        RunCommand::new(
            id("run-a"),
            id("command-stale"),
            id("key-stale"),
            CommandPayload::NodeProgress(super::NodeProgressCommand::new(id("missing-execution"))),
            20,
        ),
        CommandRejection::StaleNodeExecution,
    );
    let approval = ledger.accept(approval("run-a", "command-approval", "key-approval", 30));

    assert_eq!(graph_patch.record().sequence(), 1);
    assert!(graph_patch.record().is_accepted());
    assert_eq!(stale_node.record().sequence(), 2);
    assert!(stale_node.record().is_rejected());
    assert_eq!(approval.record().sequence(), 3);
    assert!(approval.record().is_accepted());
    assert_eq!(approval.events().len(), 1);
    assert_eq!(approval.events()[0].sequence(), 2);
    assert_eq!(
        approval.events()[0].event_type(),
        TeamEventType::ApprovalRequested
    );
    assert!(matches!(
        approval.events()[0].payload(),
        TeamEventPayload::ApprovalRequested { .. }
    ));
}

#[test]
fn runtime_generated_graph_patch_event_ids_stay_bounded() {
    let mut ledger = EventLedger::default();
    let run_id = "teamrun-e6457829-ec5d-44c9-b18a-06239cf7c000";
    let key = "team:123456789012:graph-patch:550e8400-e29b-41d4-a716-446655440000";
    let command_id = format!("graph-patch:{key}");

    let receipt = ledger
        .try_accept(graph_patch(run_id, &command_id, key, 10))
        .unwrap();

    assert_eq!(receipt.events().len(), 1);
    assert!(receipt.events()[0].event_id().len() <= 128);
    assert_eq!(EventLedger::restore(ledger.snapshot()).unwrap(), ledger);
}

#[test]
fn rejected_commands_are_durable_audit_records_without_teamrun_events() {
    let mut ledger = EventLedger::default();
    let command = RunCommand::new(
        id("run-a"),
        id("command-stale"),
        id("key-stale"),
        CommandPayload::NodeProgress(super::NodeProgressCommand::new(id("missing-execution"))),
        20,
    );

    let receipt = ledger.reject(command, CommandRejection::StaleNodeExecution);

    assert!(receipt.record().is_rejected());
    assert_eq!(
        receipt.record().rejection_reason(),
        Some(CommandRejection::StaleNodeExecution)
    );
    assert!(receipt.events().is_empty());
    assert!(ledger.events_for_run("run-a").next().is_none());
}

#[test]
fn accepted_command_idempotency_replays_without_requiring_the_same_created_at() {
    let mut ledger = EventLedger::default();

    let accepted = ledger.accept(graph_patch("run-a", "command-patch", "key-patch", 10));
    let facts_before = ledger.snapshot();
    let replay = ledger.accept(graph_patch("run-a", "command-patch", "key-patch", 20));

    assert!(replay.is_replay());
    assert_eq!(replay.record(), accepted.record());
    assert!(replay.events().is_empty());
    assert_eq!(ledger.snapshot(), facts_before);
}

#[test]
fn approval_resolution_appends_a_distinct_typed_event_for_every_same_or_different_key() {
    let mut ledger = EventLedger::default();
    ledger
        .append_approval_resolution(
            id("run-a"),
            id("approval-a"),
            ApprovalDecision::Approve,
            id("resolution-key"),
            10,
        )
        .unwrap();
    ledger
        .append_approval_resolution(
            id("run-a"),
            id("approval-a"),
            ApprovalDecision::Deny,
            id("resolution-key"),
            20,
        )
        .unwrap();
    ledger
        .append_approval_resolution(
            id("run-a"),
            id("approval-a"),
            ApprovalDecision::Abort,
            id("different-key"),
            30,
        )
        .unwrap();

    let snapshot = ledger.snapshot();
    assert!(snapshot.commands().is_empty());
    assert_eq!(
        snapshot
            .events()
            .iter()
            .map(|event| event.sequence())
            .collect::<Vec<_>>(),
        vec![1, 2, 3]
    );
    assert!(matches!(
        snapshot.events()[1].payload(),
        TeamEventPayload::ApprovalResolved { decision, .. } if *decision == ApprovalDecision::Deny
    ));
    assert_eq!(snapshot.events()[2].idempotency_key(), "different-key");
    assert_eq!(
        EventLedger::restore(snapshot.clone()).unwrap().snapshot(),
        snapshot
    );
}

#[test]
fn every_run_starts_command_and_event_sequences_at_one() {
    let mut ledger = EventLedger::default();
    ledger.accept(graph_patch("run-a", "command-a", "key-a", 10));
    let receipt = ledger.accept(graph_patch("run-b", "command-b", "key-b", 20));

    assert_eq!(receipt.record().sequence(), 1);
    assert_eq!(receipt.events()[0].sequence(), 1);
}

#[test]
fn same_key_with_different_immutable_input_and_duplicate_command_id_fail_closed() {
    let mut ledger = EventLedger::default();
    ledger.accept(graph_patch("run-a", "command-a", "key-a", 10));

    assert!(
        ledger
            .try_accept(graph_patch("run-a", "command-b", "key-a", 10))
            .is_err()
    );
    assert!(
        ledger
            .try_accept(graph_patch("run-a", "command-a", "key-b", 10))
            .is_err()
    );
}

#[test]
fn unknown_stale_node_rejection_replays_without_requiring_the_same_created_at() {
    let mut ledger = EventLedger::default();

    let rejected = ledger.reject(
        RunCommand::new(
            id("unknown-run"),
            id("command-stale"),
            id("key-stale"),
            CommandPayload::NodeProgress(super::NodeProgressCommand::new(id("missing-execution"))),
            20,
        ),
        CommandRejection::UnknownRun,
    );
    let replay = ledger.reject(
        RunCommand::new(
            id("unknown-run"),
            id("command-stale"),
            id("key-stale"),
            CommandPayload::NodeProgress(super::NodeProgressCommand::new(id("missing-execution"))),
            30,
        ),
        CommandRejection::UnknownRun,
    );

    assert!(replay.is_replay());
    assert_eq!(replay.record(), rejected.record());
    assert!(ledger.events_for_run("unknown-run").next().is_none());
}

#[test]
fn snapshot_recovery_preserves_order_typed_payload_and_causation_and_rejects_tampering() {
    let mut ledger = EventLedger::default();
    ledger.accept(graph_patch("run-a", "command-patch", "key-patch", 10));
    ledger.accept(approval("run-a", "command-approval", "key-approval", 20));

    let snapshot = ledger.snapshot();
    let restored = EventLedger::restore(snapshot.clone()).unwrap();

    assert_eq!(restored.snapshot(), snapshot);
    let events = restored.events_for_run("run-a").collect::<Vec<_>>();
    assert_eq!(
        events
            .iter()
            .map(|event| event.sequence())
            .collect::<Vec<_>>(),
        vec![1, 2]
    );
    assert_eq!(events[0].causation_id(), "command-patch");
    assert_eq!(events[1].causation_id(), "command-approval");
    assert!(matches!(
        events[1].payload(),
        TeamEventPayload::ApprovalRequested { approval_id, .. } if approval_id.as_str() == "approval-a"
    ));

    assert!(EventLedger::restore(snapshot.clone().with_event_id(0, "tampered-event")).is_err());
    assert!(EventLedger::restore(snapshot.clone().with_event_sequence(1, 1)).is_err());
    assert!(EventLedger::restore(snapshot.with_event_causation_id(1, "command-patch")).is_err());
}

#[test]
fn restore_rejects_an_accepted_audit_record_without_its_typed_event() {
    let mut ledger = EventLedger::default();
    ledger.accept(graph_patch("run-a", "command-patch", "key-patch", 10));

    assert!(EventLedger::restore(ledger.snapshot().without_events()).is_err());
}

#[test]
fn restore_rejects_multiple_typed_events_for_one_accepted_command() {
    let mut ledger = EventLedger::default();
    ledger.accept(graph_patch("run-a", "command-patch", "key-patch", 10));

    assert!(
        EventLedger::restore(
            ledger
                .snapshot()
                .with_second_event_for_first_accepted_command()
        )
        .is_err()
    );
}
