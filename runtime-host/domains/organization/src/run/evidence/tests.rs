use super::{
    EvidenceId, EvidenceIdError, EvidenceLedger, EvidenceRecord, EvidenceRecordError,
    EvidenceReference, EvidenceReferenceError, EvidenceReferenceKind, RecordOutcome,
    RestoreLedgerError,
};
use crate::run::graph::{AttemptId, ExecutionFence, NodeExecutionId};

#[test]
fn evidence_references_retain_only_bounded_opaque_facts() {
    let reference = EvidenceReference::opaque(
        EvidenceReferenceKind::Artifact,
        "artifact:release:01",
        Some("release result".to_owned()),
    )
    .unwrap();

    assert_eq!(reference.kind(), EvidenceReferenceKind::Artifact);
    assert_eq!(reference.reference(), "artifact:release:01");
    assert_eq!(reference.label(), Some("release result"));
    assert_eq!(
        EvidenceReference::opaque(EvidenceReferenceKind::Uri, " \n", None),
        Err(EvidenceReferenceError::BlankReference),
    );
    assert_eq!(
        EvidenceReference::opaque(
            EvidenceReferenceKind::Uri,
            "reference",
            Some(" ".to_owned())
        ),
        Err(EvidenceReferenceError::BlankLabel),
    );
}

#[test]
fn evidence_record_keeps_only_opaque_reference_and_run_provenance() {
    let record = EvidenceRecord::new(
        EvidenceId::new("evidence-01").unwrap(),
        "run-01",
        "node-execution-01",
        EvidenceReference::opaque(EvidenceReferenceKind::Artifact, "artifact-01", None).unwrap(),
        1_000,
    )
    .unwrap();

    assert_eq!(record.evidence_id().as_str(), "evidence-01");
    assert_eq!(record.run_id(), "run-01");
    assert_eq!(record.node_execution_id(), "node-execution-01");
    assert_eq!(record.recorded_at(), 1_000);
    assert_eq!(record.reference().kind(), EvidenceReferenceKind::Artifact);
}

#[test]
fn evidence_record_rejects_blank_identity_and_provenance_without_echoing_input() {
    assert_eq!(EvidenceId::new("\t"), Err(EvidenceIdError::Blank));
    assert_eq!(
        EvidenceRecord::new(
            EvidenceId::new("evidence-01").unwrap(),
            "\n",
            "node-execution-01",
            EvidenceReference::opaque(EvidenceReferenceKind::InlineText, "done", None).unwrap(),
            1_000,
        ),
        Err(EvidenceRecordError::BlankRunId),
    );
}

#[test]
fn ledger_replays_exact_evidence_and_rejects_conflicting_record_identity() {
    let record = EvidenceRecord::new(
        EvidenceId::new("evidence-01").unwrap(),
        "run-01",
        "node-execution-01",
        EvidenceReference::opaque(EvidenceReferenceKind::Artifact, "reference:01", None).unwrap(),
        1_000,
    )
    .unwrap();
    let mut ledger = EvidenceLedger::default();

    assert_eq!(
        ledger.record(record.clone()),
        RecordOutcome::Recorded(record.clone())
    );
    assert_eq!(
        ledger.record(record.clone()),
        RecordOutcome::Replayed(record.clone())
    );

    let conflicting = EvidenceRecord::new(
        EvidenceId::new("evidence-01").unwrap(),
        "run-01",
        "node-execution-02",
        EvidenceReference::opaque(EvidenceReferenceKind::Artifact, "reference:01", None).unwrap(),
        1_001,
    )
    .unwrap();
    assert_eq!(
        ledger.record(conflicting),
        RecordOutcome::ConflictingEvidenceId {
            evidence_id: EvidenceId::new("evidence-01").unwrap(),
        },
    );
    assert_eq!(
        ledger
            .records_for_node_execution("node-execution-01")
            .count(),
        1
    );
    assert!(ledger.has_artifact_for_node_execution("node-execution-01"));
    assert_eq!(
        ledger.artifact_reference_for_node_execution("node-execution-01"),
        Some("reference:01")
    );
}

#[test]
fn artifact_lookup_does_not_promote_non_artifact_evidence() {
    let record = EvidenceRecord::new(
        EvidenceId::new("evidence-uri").unwrap(),
        "run-01",
        "node-execution-01",
        EvidenceReference::opaque(EvidenceReferenceKind::Uri, "https://example.invalid", None)
            .unwrap(),
        1,
    )
    .unwrap();
    let mut ledger = EvidenceLedger::default();
    assert!(matches!(ledger.record(record), RecordOutcome::Recorded(_)));
    assert!(!ledger.has_artifact_for_node_execution("node-execution-01"));
    assert_eq!(
        ledger.artifact_reference_for_node_execution("node-execution-01"),
        None
    );
}

#[test]
fn evidence_debug_redacts_reference_and_label() {
    let reference = EvidenceReference::opaque(
        EvidenceReferenceKind::InlineText,
        "canary-private-reference",
        Some("canary-private-label".to_owned()),
    )
    .unwrap();
    let record = EvidenceRecord::new(
        EvidenceId::new("evidence-01").unwrap(),
        "run-01",
        "node-execution-01",
        reference,
        1_000,
    )
    .unwrap();

    let rendered = format!("{record:?}");
    assert!(!rendered.contains("canary-private-reference"));
    assert!(!rendered.contains("canary-private-label"));
}

#[test]
fn artifact_lookup_requires_run_and_execution_fence_match() {
    let fence = ExecutionFence::new(
        AttemptId::for_node(
            &crate::run::graph::NodeId::new("review"),
            std::num::NonZeroU32::MIN,
        ),
        NodeExecutionId::for_attempt(&AttemptId::for_node(
            &crate::run::graph::NodeId::new("review"),
            std::num::NonZeroU32::MIN,
        )),
    );
    let record = EvidenceRecord::new(
        EvidenceId::new("evidence-artifact").unwrap(),
        "run-01",
        fence.node_execution_id().as_str(),
        EvidenceReference::opaque(EvidenceReferenceKind::Artifact, "opaque-artifact", None)
            .unwrap(),
        1,
    )
    .unwrap();
    let mut ledger = EvidenceLedger::default();
    ledger.record(record);
    assert_eq!(
        ledger.artifact_reference_for_execution("run-01", &fence),
        Some("opaque-artifact")
    );
    assert_eq!(
        ledger.artifact_reference_for_execution("run-02", &fence),
        None
    );
}

#[test]
fn uri_and_inline_text_never_match_artifact_lookup() {
    let fence = ExecutionFence::new(
        AttemptId::for_node(
            &crate::run::graph::NodeId::new("review"),
            std::num::NonZeroU32::MIN,
        ),
        NodeExecutionId::for_attempt(&AttemptId::for_node(
            &crate::run::graph::NodeId::new("review"),
            std::num::NonZeroU32::MIN,
        )),
    );
    let mut ledger = EvidenceLedger::default();
    for (id, kind) in [
        ("uri", EvidenceReferenceKind::Uri),
        ("inline", EvidenceReferenceKind::InlineText),
    ] {
        ledger.record(
            EvidenceRecord::new(
                EvidenceId::new(id).unwrap(),
                "run-01",
                fence.node_execution_id().as_str(),
                EvidenceReference::opaque(kind, "not-an-artifact", None).unwrap(),
                1,
            )
            .unwrap(),
        );
    }
    assert_eq!(
        ledger.artifact_reference_for_execution("run-01", &fence),
        None
    );
}

#[test]
fn ledger_restore_rejects_duplicate_evidence_identity() {
    let record = EvidenceRecord::new(
        EvidenceId::new("evidence-01").unwrap(),
        "run-01",
        "node-execution-01",
        EvidenceReference::opaque(EvidenceReferenceKind::InlineText, "reference:done", None)
            .unwrap(),
        1_000,
    )
    .unwrap();

    assert_eq!(
        EvidenceLedger::restore([record.clone(), record]),
        Err(RestoreLedgerError::DuplicateEvidenceId(
            EvidenceId::new("evidence-01").unwrap(),
        )),
    );
}
