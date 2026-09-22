use std::num::NonZeroU32;

use super::*;
use crate::run::graph::{
    AttemptId, AttemptReason, AttemptStatus, ExecutionFence, GraphRunId, NodeAttempt,
    NodeDefinition, NodeExecutionId, NodeId, NodeKind,
};

fn attempt(node: &NodeId) -> NodeAttempt {
    NodeAttempt::create(
        node.clone(),
        NodeKind::Work,
        NonZeroU32::MIN,
        AttemptStatus::Running,
        AttemptReason::Initial,
        Vec::new(),
        1,
    )
}
fn node() -> NodeDefinition {
    NodeDefinition::control(
        NodeId::new("build"),
        NodeKind::Work,
        "Build",
        NonZeroU32::MIN,
    )
}
fn record() -> ArtifactRecord {
    let node = node();
    let attempt = attempt(node.id());
    build_graph_completion_artifact(
        &GraphRunId::new("run-1"),
        &node,
        &attempt,
        "builder",
        CompletionMetadata {
            output_port: "completed".into(),
            summary: Some("done".into()),
            evidence: vec![ArtifactEvidenceProvenance::new("evidence-1", "artifact").unwrap()],
        },
        "command-1",
        "key-1",
        2,
    )
    .unwrap()
    .artifact
}

#[test]
fn completion_record_uses_current_fence_and_redacts_content() {
    let artifact = record();
    assert_eq!(
        artifact.node_execution_id(),
        artifact.fence().node_execution_id().as_str()
    );
    assert_eq!(artifact.kind(), "nodeSummary");
    assert_eq!(artifact.content_ref(), "evidence-1");
    let debug = format!("{artifact:?}");
    assert!(!debug.contains("evidence-1"));
}

#[test]
fn ledger_replays_conflicts_and_restores_strictly() {
    let artifact = record();
    let mut ledger = ArtifactLedger::default();
    assert_eq!(
        ledger.record(artifact.clone()),
        ArtifactRecordOutcome::Recorded(artifact.clone())
    );
    assert_eq!(
        ledger.record(artifact.clone()),
        ArtifactRecordOutcome::Replayed(artifact.clone())
    );
    let mut different = record();
    different = ArtifactRecord::new(
        different.artifact_id().clone(),
        "run-2",
        different.node_id(),
        different.node_execution_id(),
        different.fence().clone(),
        different.role_id(),
        different.kind(),
        different.title(),
        different.content_ref(),
        different.summary().map(ToOwned::to_owned),
        different.evidence().to_vec(),
        different.source_envelope_id(),
        different.idempotency_key(),
        different.created_at(),
    )
    .unwrap();
    assert!(matches!(
        ledger.record(different),
        ArtifactRecordOutcome::ConflictingArtifactId { .. }
    ));
    assert!(matches!(
        ArtifactLedger::restore([artifact.clone(), artifact]),
        Err(RestoreArtifactLedgerError::DuplicateArtifactId(_))
    ));
}

#[test]
fn downstream_projection_never_fetches_content() {
    let artifact = record();
    let id = artifact.artifact_id().clone();
    let ledger = ArtifactLedger::restore([artifact]).unwrap();
    let contexts = build_graph_delivery_input_context(
        &ledger,
        [DownstreamInputContextInput {
            run_id: GraphRunId::new("run-1"),
            source_fence: ledger.records().next().unwrap().fence().clone(),
            edge_id: "edge".into(),
            source_node_id: "build".into(),
            source_node_execution_id: "build:attempt:1".into(),
            action: "activate".into(),
            include_upstream_result: true,
            artifact_ids: vec![id.clone()],
            source_summary: Some("summary".into()),
        }],
    );
    assert_eq!(contexts[0].artifact_ids, vec![id]);
    assert_eq!(contexts[0].source_summary.as_deref(), Some("summary"));
    let public = project_public_artifact(ledger.records().next().unwrap());
    assert_eq!(public.evidence_count, 1);
}

#[test]
fn lookup_requires_exact_run_and_fence() {
    let artifact = record();
    let ledger = ArtifactLedger::restore([artifact.clone()]).unwrap();
    assert!(
        ledger
            .lookup_for_execution(&GraphRunId::new("run-1"), artifact.fence())
            .is_some()
    );
    assert!(
        ledger
            .lookup_for_execution(&GraphRunId::new("run-2"), artifact.fence())
            .is_none()
    );
    let other_attempt = AttemptId::for_node(&NodeId::new("build"), NonZeroU32::new(2).unwrap());
    let other = ExecutionFence::new(
        other_attempt.clone(),
        NodeExecutionId::for_attempt(&other_attempt),
    );
    assert!(
        ledger
            .lookup_for_execution(&GraphRunId::new("run-1"), &other)
            .is_none()
    );
}
