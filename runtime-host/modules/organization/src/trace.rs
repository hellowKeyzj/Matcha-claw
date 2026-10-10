use platform::trace::identifier_hash;
use serde_json::{Value, json};

use crate::{GraphDefinition, GraphState};

// Only call from lazy trace payloads; never format errors containing domain data.
pub(crate) fn terminal_error(error: &crate::StoreFault) -> Value {
    use crate::{ActivityTransitionError as Activity, NativeRunOutputResolutionError as Output, StoreFault, TerminalObservationError as Observation};
    let (kind, reason) = match error {
        StoreFault::TerminalObservation(error) => ("terminal_observation", match error {
            Observation::DeliveryMismatch => "delivery_mismatch",
            Observation::DeliveryNotAccepted => "delivery_not_accepted",
            Observation::RunMismatch => "run_mismatch",
            Observation::NodeMismatch => "node_mismatch",
            Observation::StaleFence => "stale_fence",
            Observation::SessionMismatch => "session_mismatch",
            Observation::NativeReceiptMismatch => "native_receipt_mismatch",
            Observation::ConflictingObservation => "conflicting_observation",
        }),
        StoreFault::AuthorizedGraphResolution(error) => ("graph_resolution", resolution_reason(error)),
        StoreFault::NativeRunOutputResolution(error) => ("native_output", match error {
            Output::InvalidOutput => "invalid_output",
            Output::NativeTerminalNotResolvable => "terminal_not_resolvable",
            Output::AuthorizedResolution(error) => resolution_reason(error),
        }),
        StoreFault::ActivityTransition(error) => ("activity_transition", match error {
            Activity::StaleClaim => "stale_claim",
            Activity::NotClaimed { .. } => "not_claimed",
            Activity::NotDispatched { .. } => "not_dispatched",
            Activity::CannotSettle { .. } => "cannot_settle",
        }),
        StoreFault::DeliveryReceipt(error) => ("delivery_receipt", match error.as_ref() {
            crate::DeliveryReceiptError::DeliveryMismatch { .. } => "delivery_mismatch",
            crate::DeliveryReceiptError::StaleClaim { .. } => "stale_claim",
            crate::DeliveryReceiptError::NotDelivering { .. } => "not_delivering",
        }),
        StoreFault::RuntimeReceipt(error) => ("runtime_receipt", terminal_facts_reason(error)),
        StoreFault::Evidence(error) => ("evidence", terminal_facts_reason(error)),
        StoreFault::WriterBusy => ("store", "writer_busy"),
        StoreFault::Lock(_) => ("store", "lock"),
        StoreFault::Read(_) => ("store", "read"),
        StoreFault::Recovery(_) => ("store", "recovery"),
        StoreFault::Commit(_) => ("store", "commit"),
        StoreFault::CommitOutcomeUnknown(_) => ("store", "commit_outcome_unknown"),
        StoreFault::RecoveryRequired => ("store", "recovery_required"),
        StoreFault::MigrationRequired => ("store", "migration_required"),
        StoreFault::RecordTooLarge => ("store", "record_too_large"),
        StoreFault::LogFull => ("store", "log_full"),
        StoreFault::EpochOverflow => ("store", "epoch_overflow"),
        StoreFault::CorruptRecord => ("store", "corrupt_record"),
        StoreFault::UnsupportedSchemaVersion(_) => ("store", "unsupported_schema_version"),
        StoreFault::InvalidFacts => ("facts", "invalid_facts"),
        StoreFault::Design(_) => ("domain", "design"),
        StoreFault::RuntimeGraph(_) => ("domain", "runtime_graph"),
        StoreFault::GraphPatchInput(_) => ("domain", "graph_patch_input"),
        StoreFault::DeliveryRequest(_) => ("domain", "delivery_request"),
        StoreFault::TriggerFire(_) => ("domain", "trigger_fire"),
        StoreFault::AgentNodeEventResolution(_) => ("domain", "agent_node_event"),
        StoreFault::GraphPatch(_) => ("domain", "graph_patch"),
        StoreFault::EventLedger(_) => ("domain", "event_ledger"),
        StoreFault::ControlNodeResolution(_) => ("domain", "control_resolution"),
        StoreFault::ControlExecution(_) => ("domain", "control_execution"),
        StoreFault::ReadySchedule(_) => ("domain", "ready_schedule"),
        StoreFault::GraphReduce(_) => ("domain", "graph_reduce"),
    };
    let io_kind = match error {
        StoreFault::Lock(kind) | StoreFault::Read(kind) | StoreFault::Recovery(kind)
        | StoreFault::Commit(kind) | StoreFault::CommitOutcomeUnknown(kind) => Some(format!("{kind:?}")),
        _ => None,
    };
    json!({ "kind": kind, "reason": reason, "ioKind": io_kind })
}

fn resolution_reason(error: &crate::AuthorizedGraphResolutionError) -> &'static str {
    use crate::AuthorizedGraphResolutionError::*;
    match error {
        DeliveryNotAwaitingAuthorizedResolution => "delivery_not_awaiting",
        DeliveryMismatch => "delivery_mismatch",
        RunMismatch => "run_mismatch",
        NodeMismatch => "node_mismatch",
        StaleFence => "stale_fence",
        GraphStateMismatch => "graph_state_mismatch",
        OutputPortDoesNotMatchEdge => "output_port_edge_mismatch",
        ConflictingResolution => "conflicting_resolution",
    }
}

pub(crate) fn terminal_facts_reason(error: &crate::OrganizationFactsError) -> &'static str {
    use crate::OrganizationFactsError::*;
    match error {
        UnknownRun => "unknown_run",
        InvalidGraphRun => "invalid_graph_run",
        InvalidGraphRunLifecycle => "invalid_run_lifecycle",
        InvalidRunStartGate => "invalid_start_gate",
        InvalidTerminalObservation => "invalid_terminal_observation",
        InvalidDeliveryLedger(_) => "invalid_delivery_ledger",
        InvalidActivityLedger(_) => "invalid_activity_ledger",
        InvalidEvidenceLedger => "invalid_evidence_ledger",
        InvalidArtifactLedger => "invalid_artifact_ledger",
        InvalidEventLedger => "invalid_event_ledger",
        UnknownEvidenceRun => "unknown_evidence_run",
        StaleEvidenceNodeExecution => "stale_evidence_execution",
        ConflictingEvidenceId => "conflicting_evidence_id",
        EvidenceChanged => "evidence_changed",
        ArtifactChanged => "artifact_changed",
        UnknownDeliveryRun => "unknown_delivery_run",
        UnknownActivityRun => "unknown_activity_run",
        UnknownActivity => "unknown_activity",
        InvalidActivity => "invalid_activity",
        InvalidActivityTarget => "invalid_activity_target",
        DuplicateAuthorizedGraphResolution => "duplicate_graph_resolution",
        DuplicateMatchaTerminalCorrelation => "duplicate_terminal_correlation",
        RemovedRun => "removed_run",
        RunOwnershipChanged => "run_ownership_changed",
        RemovedDelivery => "removed_delivery",
        DeliveryIdentityChanged => "delivery_identity_changed",
        InvalidDeliveryTransition => "invalid_delivery_transition",
        RemovedActivity => "removed_activity",
        ActivityIdentityChanged => "activity_identity_changed",
        InvalidActivityTransition => "invalid_activity_transition",
        InvalidTaskBoard => "invalid_task_board",
        RemovedTeam => "removed_team",
        InvalidTeamTransition => "invalid_team_transition",
        RemovedMaterialization => "removed_materialization",
        MaterializationChanged => "materialization_changed",
        ControlResolutionChanged => "control_resolution_changed",
        ApprovalChanged => "approval_changed",
        EventLedgerChanged => "event_ledger_changed",
        TriggerRegistrationChanged => "trigger_registration_changed",
        InvalidControlResolutionLedger => "invalid_control_ledger",
        InvalidControlNodeResolution => "invalid_control_resolution",
        InvalidApprovalLedger => "invalid_approval_ledger",
        InvalidDecisionLedger => "invalid_decision_ledger",
        InvalidTriggerLedger(_) => "invalid_trigger_ledger",
        InvalidTriggerRegistration => "invalid_trigger_registration",
        _ => "other_facts_invariant",
    }
}

pub(crate) fn port(value: &str) -> Value {
    json!({
        "value": match value {
            "completed" | "failed" | "rework" | "passed" | "approved" | "rejected"
            | "aborted" | "joined" | "input" => Some(value),
            _ => None,
        },
        "hash": identifier_hash(value),
        "length": value.encode_utf16().count(),
    })
}

// Called only inside a lazy trace payload; graph content and user labels stay private.
pub(crate) fn graph(graph: &GraphState) -> Value {
    const LIMIT: usize = 32;
    let definition = graph.definition();
    json!({
        "versionHash": crate::store::codec::graph_version(definition).ok().map(|value| identifier_hash(&value)),
        "nodeCount": definition.nodes().len(),
        "nodesTruncated": definition.nodes().len() > LIMIT,
        "nodes": definition.nodes().iter().take(LIMIT).map(|node| json!({
            "nodeHash": identifier_hash(node.id().as_str()),
            "kind": format!("{:?}", node.kind()),
            "status": graph.current_attempt(node.id()).map(|attempt| format!("{:?}", attempt.status())),
        })).collect::<Vec<_>>(),
        "edgeCount": definition.edges().len(),
        "edgesTruncated": definition.edges().len() > LIMIT,
        "edges": definition.edges().iter().take(LIMIT).map(edge).collect::<Vec<_>>(),
    })
}

pub(crate) fn edge(edge: &crate::EdgeDefinition) -> Value {
    json!({
        "edgeHash": identifier_hash(edge.id().as_str()),
        "sourceNodeHash": identifier_hash(edge.source_node_id().as_str()),
        "targetNodeHash": identifier_hash(edge.target_node_id().as_str()),
        "sourcePort": port(edge.source_port()), "targetPort": port(edge.target_port()),
        "action": format!("{:?}", edge.action()),
    })
}

pub(crate) fn patch_edges(operations: &[crate::GraphPatchOperation]) -> Value {
    use crate::GraphPatchOperation::{AddEdge, RemoveEdge, ReplaceEdge};
    let edges = operations.iter().filter(|op| matches!(op, AddEdge(_) | ReplaceEdge(_) | RemoveEdge(_)));
    let count = edges.clone().count();
    json!({
        "edgeOperationCount": count, "edgesTruncated": count > 32,
        "edges": edges.take(32).map(|op| match op {
            AddEdge(value) => json!({"operation": "add", "edge": edge(value)}),
            ReplaceEdge(value) => json!({"operation": "replace", "edge": edge(value)}),
            RemoveEdge(id) => json!({"operation": "remove", "edgeHash": identifier_hash(id.as_str())}),
            _ => unreachable!(),
        }).collect::<Vec<_>>(),
    })
}

pub(crate) fn graph_write_result(
    facts: &crate::OrganizationFacts,
    run_id: &crate::GraphRunId,
    operation: &'static str,
    result: Result<bool, &crate::StoreFault>,
) {
    platform::trace::runtime_trace("runtime.team_run.graph_write.result", || json!({
        "operation": operation, "runHash": identifier_hash(run_id.as_str()),
        "outcome": match result {
            Ok(true) => "replayed",
            Ok(false) => "committed",
            Err(crate::StoreFault::CommitOutcomeUnknown(_)) => "commit_outcome_unknown",
            Err(_) => "failed",
        },
        "canonical": result.is_ok().then(|| facts.run(run_id).map(|run| graph(run.graph()))),
    }));
}

pub(crate) fn control_port_check(definition: &GraphDefinition, node_id: &crate::NodeId, expected: &str) -> Value {
    let node = definition.node(node_id);
    let outgoing_count = definition.outgoing_edges(node_id).count();
    json!({
        "nodeHash": identifier_hash(node_id.as_str()),
        "nodeKind": node.map(|node| format!("{:?}", node.kind())),
        "runHash": identifier_hash(definition.run_id().as_str()),
        "expectedSourcePort": port(expected),
        "outgoingCount": outgoing_count,
        "edgesTruncated": outgoing_count > 32,
        "outgoingEdges": definition.outgoing_edges(node_id).take(32).map(|edge| json!({
            "edgeHash": identifier_hash(edge.id().as_str()),
            "targetNodeHash": identifier_hash(edge.target_node_id().as_str()),
            "sourcePort": port(edge.source_port()),
            "targetPort": port(edge.target_port()),
            "matchesExpected": expected == edge.source_port(),
        })).collect::<Vec<_>>(),
    })
}
